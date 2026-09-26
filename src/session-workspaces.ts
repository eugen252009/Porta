import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DirectArgvProcessRunner, ProcessRunner } from "./process-runner.js";
import { failure } from "./contracts.js";

export type GitTransport = "ssh" | "https" | "other";
export interface SessionWorkspaceRecord {
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly state: "active" | "saved";
  readonly name: string;
  readonly repository?: string;
  readonly credentialIds: readonly string[];
  readonly createdAt: string;
}
interface Registry { readonly version: 1; readonly workspaces: readonly SessionWorkspaceRecord[] }
export interface WorkspaceCloneCredentials {
  readonly credentialId?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly temporaryDirectory?: string;
  readonly cleanup?: () => Promise<void>;
}
export interface WorkspaceCredentialResolver { resolveForClone(sessionId: string, credentialIds: readonly string[], remote: string): Promise<WorkspaceCloneCredentials | undefined>; validateAssignments?(sessionId: string, credentialIds: readonly string[]): Promise<void> }
export interface CreateWorkspaceInput { readonly repository?: string; readonly credentialIds?: readonly string[]; readonly savedProjectId?: string; readonly signal?: AbortSignal }
export interface SessionWorkspaceSummary { readonly workspaceId: string; readonly name: string; readonly state: "active" | "saved"; readonly repository?: string; readonly sessionId?: string }

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REMOTE_CHARS = 4096;

/** Server-owned, session-scoped workspace directories. User paths are never accepted as workspace roots. */
export class SessionWorkspaceManager {
  readonly root: string;
  private readonly registryPath: string;
  private registry?: Registry;
  private mutex: Promise<void> = Promise.resolve();
  constructor(dataDirectory: string, private readonly runner: ProcessRunner = new DirectArgvProcessRunner(), private readonly credentials?: WorkspaceCredentialResolver, private readonly cloneTimeoutMs = 10 * 60 * 1000) {
    this.root = resolve(dataDirectory, "workspaces");
    this.registryPath = resolve(dataDirectory, "workspaces.json");
  }
  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
    await this.load();
  }
  async createForSession(sessionId: string, input: CreateWorkspaceInput = {}): Promise<SessionWorkspaceSummary> {
    assertSessionId(sessionId);
    return this.exclusive(async () => {
      const registry = await this.load();
      const existing = registry.workspaces.find((item) => item.sessionId === sessionId);
      if (existing) {
        if (input.repository && input.repository !== existing.repository) throw failure("CAPABILITY_CONFLICT", "This session already owns a different workspace.");
        await assertDirectWorkspace(this.workspacePath(existing.workspaceId), this.root);
        return summary(existing);
      }
      const credentialIds = [...new Set(input.credentialIds ?? [])];
      if (credentialIds.length > 16 || credentialIds.some((id) => !uuid(id))) throw failure("VALIDATION_FAILED", "Git credential selection is invalid.");
      await this.credentials?.validateAssignments?.(sessionId, credentialIds);
      if (input.savedProjectId) return this.bindSavedProjectLocked(registry, sessionId, input.savedProjectId, credentialIds);
      const repository = input.repository === undefined ? undefined : validateGitRemote(input.repository);
      const workspaceId = randomUUID();
      const stage = join(this.root, `.setup-${workspaceId}`);
      const destination = this.workspacePath(workspaceId);
      const record: SessionWorkspaceRecord = { workspaceId, sessionId, state: "active", name: repository ? repositoryName(repository) : "Workspace", ...(repository ? { repository } : {}), credentialIds, createdAt: new Date().toISOString() };
      await fs.mkdir(stage, { mode: 0o700 });
      try {
        if (repository) await this.clone(sessionId, credentialIds, repository, stage, input.signal);
        await fs.rename(stage, destination);
        await assertDirectWorkspace(destination, this.root);
        const next = { version: 1 as const, workspaces: [...registry.workspaces, record] };
        await this.save(next);
        this.registry = next;
        return summary(record);
      } catch (error) {
        await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }
  async ensureForSession(sessionId: string): Promise<string> {
    assertSessionId(sessionId);
    const registry = await this.load();
    const record = registry.workspaces.find((item) => item.sessionId === sessionId);
    if (record) { const path = this.workspacePath(record.workspaceId); await assertDirectWorkspace(path, this.root); return path; }
    const created = await this.createForSession(sessionId);
    return this.workspacePath(created.workspaceId);
  }
  async workspaceForSession(sessionId: string): Promise<string> { return this.ensureForSession(sessionId); }
  async savedProjects(): Promise<readonly SessionWorkspaceSummary[]> { return (await this.load()).workspaces.filter((item) => item.state === "saved").map(summary); }
  async activeWorkspaces(): Promise<readonly SessionWorkspaceSummary[]> { return (await this.load()).workspaces.filter((item) => item.state === "active").map(summary); }
  async summaryForSession(sessionId: string): Promise<SessionWorkspaceSummary | undefined> { const item = (await this.load()).workspaces.find((record) => record.sessionId === sessionId); return item ? summary(item) : undefined; }
  async deleteSavedProject(workspaceId: string): Promise<void> {
    return this.exclusive(async () => {
      const registry = await this.load(); const record = registry.workspaces.find((item) => item.workspaceId === workspaceId && item.state === "saved");
      if (!record) throw failure("CAPABILITY_UNAVAILABLE", "Saved project was not found or is in use.");
      const path = this.workspacePath(record.workspaceId); await assertDirectWorkspace(path, this.root);
      const next = { version: 1 as const, workspaces: registry.workspaces.filter((item) => item.workspaceId !== workspaceId) };
      const tombstone = join(this.root, `.delete-${randomUUID()}`); await fs.rename(path, tombstone);
      try { await this.save(next); } catch (error) { await fs.rename(tombstone, path).catch(() => undefined); throw error; }
      this.registry = next; await fs.rm(tombstone, { recursive: true, force: false });
    });
  }
  async credentialIdsForSession(sessionId: string): Promise<readonly string[]> { const item = (await this.load()).workspaces.find((record) => record.sessionId === sessionId); return item?.credentialIds ?? []; }
  async updateCredentialAssignments(sessionId: string, credentialIds: readonly string[], expectedCredentialIds: readonly string[]): Promise<SessionWorkspaceSummary> {
    assertSessionId(sessionId);
    return this.exclusive(async () => {
      const registry = await this.load(); const record = registry.workspaces.find((item) => item.sessionId === sessionId && item.state === "active");
      if (!record) throw failure("CAPABILITY_UNAVAILABLE", "An active session workspace was not found.");
      const uniqueIds = [...new Set(credentialIds)];
      if (uniqueIds.length > 16 || uniqueIds.some((id) => !uuid(id)) || expectedCredentialIds.length > 16 || expectedCredentialIds.some((id) => !uuid(id)) || new Set(expectedCredentialIds).size !== expectedCredentialIds.length) throw failure("VALIDATION_FAILED", "Git credential selection is invalid.");
      if (record.credentialIds.length !== expectedCredentialIds.length || record.credentialIds.some((id, index) => id !== expectedCredentialIds[index])) throw failure("CAPABILITY_CONFLICT", "Session Git credentials changed since they were loaded. Refresh the assignment list before updating.");
      await this.credentials?.validateAssignments?.(sessionId, uniqueIds);
      const updated = { ...record, credentialIds: uniqueIds };
      const next = { version: 1 as const, workspaces: registry.workspaces.map((item) => item.workspaceId === record.workspaceId ? updated : item) };
      await this.save(next); this.registry = next; return summary(updated);
    });
  }
  async isCredentialAssigned(credentialId: string): Promise<boolean> { return (await this.load()).workspaces.some((record) => record.credentialIds.includes(credentialId)); }
  async deleteSessionWorkspace(sessionId: string, disposition: "keep" | "delete"): Promise<{ savedProjectId?: string }> {
    assertSessionId(sessionId);
    return this.exclusive(async () => {
      const registry = await this.load();
      const record = registry.workspaces.find((item) => item.sessionId === sessionId);
      if (!record) return {};
      if (disposition === "keep") {
        const saved: SessionWorkspaceRecord = { ...record, sessionId: undefined, state: "saved", credentialIds: [] };
        const next = { version: 1 as const, workspaces: registry.workspaces.map((item) => item.workspaceId === record.workspaceId ? saved : item) };
        await this.save(next); this.registry = next;
        return { savedProjectId: record.workspaceId };
      }
      const path = this.workspacePath(record.workspaceId);
      await assertDirectWorkspace(path, this.root);
      const tombstone = join(this.root, `.delete-${randomUUID()}`); await fs.rename(path, tombstone);
      const next = { version: 1 as const, workspaces: registry.workspaces.filter((item) => item.workspaceId !== record.workspaceId) };
      try { await this.save(next); } catch (error) { await fs.rename(tombstone, path).catch(() => undefined); throw error; }
      this.registry = next; await fs.rm(tombstone, { recursive: true, force: false });
      return {};
    });
  }
  private async bindSavedProjectLocked(registry: Registry, sessionId: string, workspaceId: string, credentialIds: readonly string[]): Promise<SessionWorkspaceSummary> {
    if (!uuid(workspaceId)) throw failure("VALIDATION_FAILED", "Saved project ID is invalid.");
    const record = registry.workspaces.find((item) => item.workspaceId === workspaceId && item.state === "saved");
    if (!record) throw failure("CAPABILITY_UNAVAILABLE", "Saved project was not found or is already in use.");
    const path = this.workspacePath(record.workspaceId);
    await assertDirectWorkspace(path, this.root);
    const bound: SessionWorkspaceRecord = { ...record, sessionId, state: "active", credentialIds };
    const next = { version: 1 as const, workspaces: registry.workspaces.map((item) => item.workspaceId === workspaceId ? bound : item) };
    await this.save(next); this.registry = next;
    return summary(bound);
  }
  private async clone(sessionId: string, credentialIds: readonly string[], remote: string, destination: string, externalSignal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cloneTimeoutMs);
    const abortFromCaller = () => controller.abort();
    if (externalSignal?.aborted) controller.abort(); else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
    let credentials: WorkspaceCloneCredentials | undefined;
    try {
      credentials = await this.credentials?.resolveForClone(sessionId, credentialIds, remote);
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.PORTA_GIT_HOME ?? "/nonexistent",
        GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "15", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
        GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: "protocol.ext.allow", GIT_CONFIG_VALUE_2: "never",
        GIT_CONFIG_KEY_3: "protocol.file.allow", GIT_CONFIG_VALUE_3: "always",
        GIT_CONFIG_KEY_4: "protocol.ssh.allow", GIT_CONFIG_VALUE_4: "always",
        GIT_CONFIG_KEY_5: "protocol.https.allow", GIT_CONFIG_VALUE_5: "always",
        GIT_CONFIG_KEY_6: "protocol.http.allow", GIT_CONFIG_VALUE_6: "always",
        GIT_CONFIG_KEY_7: "uploadpack.packObjectsHook", GIT_CONFIG_VALUE_7: "",
        GIT_CONFIG_KEY_8: "protocol.allow", GIT_CONFIG_VALUE_8: "never",
        GIT_CONFIG_KEY_9: "protocol.git.allow", GIT_CONFIG_VALUE_9: "always",
        GIT_CONFIG_KEY_10: "credential.helper", GIT_CONFIG_VALUE_10: "",
        GIT_CONFIG_KEY_11: "http.extraHeader", GIT_CONFIG_VALUE_11: "",
        GIT_CONFIG_KEY_12: "http.proxy", GIT_CONFIG_VALUE_12: "",
        GIT_CONFIG_KEY_13: "submodule.recurse", GIT_CONFIG_VALUE_13: "false",
        GIT_CONFIG_KEY_14: "push.recurseSubmodules", GIT_CONFIG_VALUE_14: "no",
        GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...(credentials?.environment ?? {}),
      };
      const result = await this.runner.run({ executable: process.env.PORTA_GIT_EXECUTABLE ?? "git", args: ["-c", "core.hooksPath=/dev/null", "clone", "--no-recurse-submodules", "--", remote, destination], cwd: this.root, environment: env, signal: controller.signal, deadline: Date.now() + this.cloneTimeoutMs, maxStdoutBytes: 16_384, maxStderrBytes: 16_384 });
      if (result.status !== "completed" || result.exitCode !== 0) throw failure(result.status === "timed-out" ? "TIMEOUT" : result.status === "cancelled" ? "CANCELLED" : "CAPABILITY_UNAVAILABLE", safeCloneError(result.stderr, result.status));
    } finally { clearTimeout(timeout); externalSignal?.removeEventListener("abort", abortFromCaller); await credentials?.cleanup?.(); }
  }
  private workspacePath(workspaceId: string): string { if (!uuid(workspaceId)) throw failure("STORAGE_FAILED", "Workspace registry contains an invalid identifier."); return join(this.root, workspaceId); }
  private async load(): Promise<Registry> {
    if (this.registry) return this.registry;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.registryPath, "utf8"));
      if (!value || typeof value !== "object" || (value as Registry).version !== 1 || !Array.isArray((value as Registry).workspaces)) throw new Error("invalid workspace registry");
      const items = (value as Registry).workspaces;
      if (items.some((item) => !validWorkspaceRecord(item)) || new Set(items.map((item) => item.workspaceId)).size !== items.length || new Set(items.flatMap((item) => item.sessionId ? [item.sessionId] : [])).size !== items.filter((item) => item.sessionId).length) throw new Error("invalid workspace registry entries");
      this.registry = value as Registry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") this.registry = { version: 1, workspaces: [] };
      else throw failure("STORAGE_FAILED", "Workspace registry is unreadable; refusing to create or delete workspace data.");
    }
    return this.registry;
  }
  private async save(registry: Registry): Promise<void> {
    await fs.mkdir(dirname(this.registryPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.registryPath}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(registry)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, this.registryPath);
    await fs.chmod(this.registryPath, 0o600);
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> { let release!: () => void; const previous = this.mutex; this.mutex = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } }
}

export function validateGitRemote(remote: string): string {
  if (typeof remote !== "string" || !remote.trim() || remote.length > MAX_REMOTE_CHARS || /[\0\r\n]/.test(remote) || remote.startsWith("-")) throw failure("VALIDATION_FAILED", "Repository remote is invalid.");
  const value = remote.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    let url: URL; try { url = new URL(value); } catch { throw failure("VALIDATION_FAILED", "Repository URL is invalid."); }
    if (url.password || (/^https?:$/i.test(url.protocol) && url.username)) throw failure("VALIDATION_FAILED", "Do not put credentials in a repository URL; select an assigned Git credential instead.");
  }
  if (/^https?:\/\/[^/]*\s/i.test(value)) throw failure("VALIDATION_FAILED", "Repository URL is invalid.");
  return value;
}
function repositoryName(remote: string): string { const clean = remote.replace(/\/$/, "").replace(/\.git$/i, ""); const name = clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf(":")) + 1); return name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "Repository"; }
function summary(record: SessionWorkspaceRecord): SessionWorkspaceSummary { return { workspaceId: record.workspaceId, name: record.name, state: record.state, ...(record.repository ? { repository: record.repository } : {}), ...(record.sessionId ? { sessionId: record.sessionId } : {}) }; }
function validWorkspaceRecord(value: unknown): value is SessionWorkspaceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.workspaceId !== "string" || !uuid(item.workspaceId) || typeof item.state !== "string" || !["active", "saved"].includes(item.state) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 80 || /[\0-\x1f]/.test(item.name) || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) || !Array.isArray(item.credentialIds) || item.credentialIds.length > 16 || item.credentialIds.some((id) => typeof id !== "string" || !uuid(id))) return false;
  if (item.state === "active" ? !validSessionId(item.sessionId as string) : item.sessionId !== undefined) return false;
  if (item.repository !== undefined) { if (typeof item.repository !== "string") return false; try { if (validateGitRemote(item.repository) !== item.repository) return false; } catch { return false; } }
  return new Set(item.credentialIds).size === item.credentialIds.length;
}
function uuid(value: string): boolean { return idPattern.test(value); }
function validSessionId(value: string): boolean { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\0-\x1f\\/]/.test(value) && value !== "." && value !== ".."; }
function assertSessionId(value: string): void { if (!validSessionId(value)) throw failure("VALIDATION_FAILED", "Session ID is invalid for workspace assignment."); }
async function assertDirectWorkspace(path: string, root: string): Promise<void> {
  const rootPath = await fs.realpath(root); const info = await fs.lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || resolve(dirname(path)) !== rootPath) throw failure("POLICY_VIOLATION", "Workspace path is not a direct, server-owned directory.");
  if (await fs.realpath(path) !== resolve(path)) throw failure("POLICY_VIOLATION", "Workspace path resolves outside its assigned location.");
}
function safeCloneError(stderr: string, status: string): string {
  if (status === "timed-out") return "Repository clone exceeded the setup deadline.";
  if (status === "cancelled") return "Repository clone was cancelled.";
  const redacted = stderr.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[REDACTED]@").replace(/\/(?:tmp|var\/tmp)\/porta-git-[A-Za-z0-9-]+/g, "[credential-temp]").replace(/(identityfile|userknownhostsfile|git_ssh_command)[^\n]*/gi, "$1 [REDACTED]").trim();
  return redacted ? `Repository clone failed: ${redacted.slice(-1200)}` : "Repository clone failed.";
}
