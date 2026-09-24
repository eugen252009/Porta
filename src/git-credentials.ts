import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { failure, HarnessFailure } from "./contracts.js";
import { validateGitRemote, type WorkspaceCloneCredentials, type WorkspaceCredentialResolver } from "./session-workspaces.js";

export type GitCredentialType = "ssh" | "https";
export type GitCredentialScope = "global" | "session";
export interface GitCredentialSummary { readonly id: string; readonly name: string; readonly type: GitCredentialType; readonly scope: GitCredentialScope; readonly sessionId?: string; readonly createdAt: string }
export type GitCredentialInput =
  | { readonly name: string; readonly type: "ssh"; readonly scope: GitCredentialScope; readonly sessionId?: string; readonly privateKey: string; readonly publicKey?: string; readonly knownHosts: string; readonly sshConfig?: string }
  | { readonly name: string; readonly type: "https"; readonly scope: GitCredentialScope; readonly sessionId?: string; readonly username: string; readonly password: string };
interface GitCredentialRecord extends GitCredentialSummary { readonly directory: string }
const namePattern = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const maxCredentialBytes = 128 * 1024;
const permittedSshDirectives = new Set(["host", "hostname", "user", "port", "hostkeyalias", "addressfamily", "canonicalizehostname"]);

/** Server-side Git credentials. Secret bytes are file-only; list() never returns them. */
export class GitCredentialStore implements WorkspaceCredentialResolver {
  readonly root: string;
  private readonly records = new Map<string, GitCredentialRecord>();
  private loaded = false;
  private mutex: Promise<void> = Promise.resolve();
  constructor(dataDirectory: string) { this.root = resolve(dataDirectory, "git-credentials"); }
  async initialize(): Promise<void> { await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); await fs.chmod(this.root, 0o700); await this.load(); }
  async create(input: GitCredentialInput): Promise<GitCredentialSummary> {
    return this.exclusive(async () => {
      await this.load(); validateCredential(input);
      const id = randomUUID(); const directory = join(this.root, id); await fs.mkdir(directory, { mode: 0o700 });
      const summary: GitCredentialSummary = { id, name: input.name, type: input.type, scope: input.scope, ...(input.scope === "session" ? { sessionId: input.sessionId } : {}), createdAt: new Date().toISOString() };
      try {
        if (input.type === "ssh") {
          await writeSecret(directory, "private-key", input.privateKey);
          if (input.publicKey) await writeSecret(directory, "public-key", input.publicKey);
          await writeSecret(directory, "known-hosts", input.knownHosts);
          if (input.sshConfig) await writeSecret(directory, "ssh-config", sanitizeSshConfig(input.sshConfig));
        } else {
          await writeSecret(directory, "username", input.username);
          await writeSecret(directory, "password", input.password);
        }
        const record: GitCredentialRecord = { ...summary, directory };
        await writeSecret(directory, "metadata.json", JSON.stringify({ id, name: summary.name, type: summary.type, scope: summary.scope, ...(summary.sessionId ? { sessionId: summary.sessionId } : {}), createdAt: summary.createdAt }));
        this.records.set(id, record); return summary;
      } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
    });
  }
  async listForSession(sessionId: string): Promise<readonly GitCredentialSummary[]> {
    await this.load(); return [...this.records.values()].filter((item) => item.scope === "global" || item.sessionId === sessionId).map(publicSummary);
  }
  async deleteSessionCredentials(sessionId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.load();
      for (const record of [...this.records.values()]) if (record.scope === "session" && record.sessionId === sessionId) { await fs.rm(record.directory, { recursive: true, force: true }); this.records.delete(record.id); }
    });
  }
  async delete(id: string): Promise<void> {
    return this.exclusive(async () => {
      await this.load(); const record = this.records.get(id); if (!record) throw failure("CAPABILITY_UNAVAILABLE", "Git credential was not found.");
      await fs.rm(record.directory, { recursive: true, force: false }); this.records.delete(id);
    });
  }
  async validateAssignments(sessionId: string, credentialIds: readonly string[]): Promise<void> {
    await this.load();
    for (const id of credentialIds) { const record = this.records.get(id); if (!record || (record.scope === "session" && record.sessionId !== sessionId)) throw failure("AUTHORIZATION_DENIED", "A selected Git credential is unavailable to this session."); }
  }
  async resolveForClone(sessionId: string, assignedIds: readonly string[], remote: string): Promise<WorkspaceCloneCredentials | undefined> {
    remote = validateGitRemote(remote);
    await this.load(); const type = gitTransport(remote);
    if (type === "other") return this.prepareUncredentialedSsh();
    const candidates = assignedIds.map((id) => {
      const item = this.records.get(id);
      if (!item) throw failure("AUTHORIZATION_DENIED", "A selected Git credential is unavailable to this session.");
      if (item.scope === "session" && item.sessionId !== sessionId) throw failure("AUTHORIZATION_DENIED", "The selected Git credential is not available to this session.");
      return item;
    });
    if (candidates.filter((item) => item.type === type).length > 1) throw failure("VALIDATION_FAILED", `Select only one ${type.toUpperCase()} credential for this repository.`);
    for (const item of candidates) {
      if (item.scope === "session" && item.sessionId !== sessionId) throw failure("AUTHORIZATION_DENIED", "The selected Git credential is not available to this session.");
      if (item.type === type) return this.prepare(item, remote);
    }
    if (candidates.length && candidates.every((item) => item.type !== type)) throw failure("AUTHORIZATION_DENIED", `No assigned ${type.toUpperCase()} credential is available for this repository.`);
    return this.prepareUncredentialedSsh();
  }
  async environmentForSession(sessionId: string, assignedIds: readonly string[], remote: string): Promise<WorkspaceCloneCredentials | undefined> {
    return this.resolveForClone(sessionId, assignedIds, remote);
  }
  private async prepare(record: GitCredentialRecord, remote: string): Promise<WorkspaceCloneCredentials> {
    const temp = join(tmpdir(), `porta-git-${randomUUID()}`); await fs.mkdir(temp, { mode: 0o700 });
    try {
      if (record.type === "ssh") {
        const targetHost = sshHost(remote);
        if (!targetHost) throw failure("VALIDATION_FAILED", "SSH repository host cannot be safely identified for credential scoping.");
        await copySecret(record.directory, "private-key", temp, "identity");
        await copySecret(record.directory, "known-hosts", temp, "known_hosts");
        const userConfig = await readOptional(record.directory, "ssh-config");
        const config = `Host ${targetHost}\n  IdentityFile ${join(temp, "identity")}\n  IdentitiesOnly yes\n  IdentityAgent none\n${userConfig ? `${userConfig.trim()}\n` : ""}Host *\n  IdentityFile /dev/null\n  IdentitiesOnly yes\n  IdentityAgent none\n  UserKnownHostsFile ${join(temp, "known_hosts")}\n  GlobalKnownHostsFile /dev/null\n  StrictHostKeyChecking yes\n  BatchMode yes\n`;
        await writeSecret(temp, "ssh_config", config);
        return { environment: isolatedGitEnvironment({ GIT_SSH_COMMAND: `ssh -F ${join(temp, "ssh_config")}` }), temporaryDirectory: temp, cleanup: () => fs.rm(temp, { recursive: true, force: true }) };
      }
      await copySecret(record.directory, "username", temp, "username"); await copySecret(record.directory, "password", temp, "password");
      const remoteUrl = new URL(remote); await writeSecret(temp, "https-host", remoteUrl.host.toLowerCase());
      const helper = `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst prompt = process.argv.slice(2).join(" ");\nconst match = prompt.match(/https?:\\/\\/[^\\s'\"]+/i);\nif (!match) process.exit(1);\nlet host; try { host = new URL(match[0]).host.toLowerCase(); } catch { process.exit(1); }\nif (host !== fs.readFileSync(__dirname + "/https-host", "utf8").trim().toLowerCase()) process.exit(1);\nif (/username/i.test(prompt)) process.stdout.write(fs.readFileSync(__dirname + "/username"));\nelse if (/password/i.test(prompt)) process.stdout.write(fs.readFileSync(__dirname + "/password"));\nelse process.exit(1);\n`;
      await writeSecret(temp, "askpass", helper); await fs.chmod(join(temp, "askpass"), 0o700);
      const sshCommand = await writeUncredentialedSshConfig(temp);
      return { environment: isolatedGitEnvironment({ GIT_ASKPASS: join(temp, "askpass"), SSH_ASKPASS: join(temp, "askpass"), GIT_SSH_COMMAND: sshCommand, GIT_TERMINAL_PROMPT: "0" }), temporaryDirectory: temp, cleanup: () => fs.rm(temp, { recursive: true, force: true }) };
    } catch (error) { await fs.rm(temp, { recursive: true, force: true }); if (error instanceof HarnessFailure) throw error; throw failure("STORAGE_FAILED", "Assigned Git credential could not be prepared."); }
  }
  private async prepareUncredentialedSsh(): Promise<WorkspaceCloneCredentials> {
    const temp = join(tmpdir(), `porta-git-${randomUUID()}`); await fs.mkdir(temp, { mode: 0o700 });
    try { const sshCommand = await writeUncredentialedSshConfig(temp); return { environment: isolatedGitEnvironment({ GIT_SSH_COMMAND: sshCommand }), temporaryDirectory: temp, cleanup: () => fs.rm(temp, { recursive: true, force: true }) }; }
    catch { await fs.rm(temp, { recursive: true, force: true }); throw failure("STORAGE_FAILED", "Isolated SSH configuration could not be prepared."); }
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !uuid(entry.name)) continue;
      const directory = join(this.root, entry.name);
      try {
        const info = await fs.lstat(directory); if (info.isSymbolicLink() || (info.mode & 0o077) !== 0) continue;
        const metadata = JSON.parse(await fs.readFile(join(directory, "metadata.json"), "utf8")) as Omit<GitCredentialRecord, "directory">;
        if (metadata.id !== entry.name || !namePattern.test(metadata.name) || !["ssh", "https"].includes(metadata.type) || !["global", "session"].includes(metadata.scope) || (metadata.scope === "session" && !metadata.sessionId)) continue;
        this.records.set(metadata.id, { ...metadata, directory } as GitCredentialRecord);
      } catch { continue; }
    }
    this.loaded = true;
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> { let release!: () => void; const previous = this.mutex; this.mutex = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } }
}

export function sshHost(remote: string): string | undefined {
  let host: string | undefined;
  if (/^(?:ssh|git\+ssh):\/\//i.test(remote)) { try { host = new URL(remote.replace(/^git\+ssh:/i, "ssh:")).hostname; } catch { return undefined; } }
  else host = /^(?:[^@/\s:]+@)?([^:/\s]+):.+/.exec(remote)?.[1];
  return host && /^[A-Za-z0-9_.-]{1,253}$/.test(host) ? host : undefined;
}
function gitTransport(remote: string): "ssh" | "https" | "other" {
  if (/^https?:\/\//i.test(remote)) return "https";
  if (/^(?:git|file):\/\//i.test(remote)) return "other";
  if (/^(?:ssh|git\+ssh):\/\//i.test(remote) || /^[^/@\s:]+@[^/\s:]+:.+/.test(remote) || /^[A-Za-z0-9_.-]+:.+/.test(remote)) return "ssh";
  return "other";
}
function validateCredential(input: GitCredentialInput): void {
  if (!namePattern.test(input.name) || !["global", "session"].includes(input.scope)) throw failure("VALIDATION_FAILED", "Git credential metadata is invalid.");
  if (input.scope === "session" && (!input.sessionId || input.sessionId.length > 200 || /[\0-\x1f\\/]/.test(input.sessionId))) throw failure("VALIDATION_FAILED", "A session-scoped Git credential requires a valid session ID.");
  if (input.scope === "global" && input.sessionId) throw failure("VALIDATION_FAILED", "Global credentials cannot be bound to a session.");
  const values = input.type === "ssh" ? [input.privateKey, input.publicKey ?? "", input.knownHosts, input.sshConfig ?? ""] : [input.username, input.password];
  if (values.some((value) => Buffer.byteLength(value, "utf8") > maxCredentialBytes)) throw failure("VALIDATION_FAILED", "Git credential files exceed the size limit.");
  if (input.type === "ssh") {
    if (!input.privateKey.trim() || !input.knownHosts.trim()) throw failure("VALIDATION_FAILED", "SSH credentials require a private key and trusted known_hosts entries.");
    sanitizeSshConfig(input.sshConfig ?? "");
  } else if (!input.username || !input.password || /[\r\n]/.test(input.username)) throw failure("VALIDATION_FAILED", "HTTPS credentials require a username and password or token.");
}
function sanitizeSshConfig(source: string): string {
  const output: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9]+)\s+(.+)$/.exec(line); if (!match) throw failure("VALIDATION_FAILED", "SSH config contains an invalid directive.");
    const key = match[1]!.toLowerCase(); const value = match[2]!.trim();
    if (!permittedSshDirectives.has(key) || /[\0\r\n]/.test(value) || value.startsWith("-") || (key === "port" && (!/^\d{1,5}$/.test(value) || Number(value) > 65535)) || (key === "hostname" && !/^[A-Za-z0-9._:-]+$/.test(value)) || (key === "user" && !/^[A-Za-z0-9._-]+$/.test(value))) throw failure("VALIDATION_FAILED", `SSH config directive '${match[1]}' is not permitted.`);
    output.push(`  ${canonicalDirective(key)} ${value}`);
  }
  return output.join("\n");
}
function canonicalDirective(value: string): string { return value.split(/(?=[A-Z])/).map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase()).join(""); }
async function writeUncredentialedSshConfig(directory: string): Promise<string> {
  const config = `Host *\n  IdentityFile /dev/null\n  IdentitiesOnly yes\n  IdentityAgent none\n  UserKnownHostsFile /dev/null\n  GlobalKnownHostsFile /etc/ssh/ssh_known_hosts\n  StrictHostKeyChecking yes\n  BatchMode yes\n`;
  await writeSecret(directory, "ssh_config", config);
  return `ssh -F ${join(directory, "ssh_config")}`;
}
function isolatedGitEnvironment(extra: Readonly<Record<string, string>>): Readonly<Record<string, string>> { return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(tmpdir(), "porta-no-home"), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...extra }; }
async function writeSecret(directory: string, name: string, value: string): Promise<void> { const path = join(directory, name); const handle = await fs.open(path, "wx", 0o600); try { await handle.writeFile(value, "utf8"); await handle.sync(); } finally { await handle.close(); } }
async function copySecret(sourceDir: string, source: string, targetDir: string, target: string): Promise<void> { const input = await fs.readFile(join(sourceDir, source)); const handle = await fs.open(join(targetDir, target), "wx", 0o600); try { await handle.writeFile(input); await handle.sync(); } finally { await handle.close(); } }
async function readOptional(directory: string, name: string): Promise<string | undefined> { try { return await fs.readFile(join(directory, name), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
function publicSummary(item: GitCredentialRecord): GitCredentialSummary { const { directory: _directory, ...summary } = item; return summary; }
function uuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
