import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthInteraction, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { z } from "zod";
import { failure } from "../contracts.js";

const credentialSchema = z.object({ type: z.literal("oauth"), access: z.string().min(1), refresh: z.string().min(1), expires: z.number().finite(), accountId: z.string().min(1) });
export type CodexCredential = z.infer<typeof credentialSchema>;
export const codexProviderModelCatalog = Object.values(OPENAI_CODEX_MODELS).map((entry) => ({ id: entry.id, displayName: entry.name }));
export interface CodexAccess { access: string; accountId: string }
export interface CodexAuthSource { getAccess(signal: AbortSignal): Promise<CodexAccess> }
export type CodexAccountState = { status: "connected" | "expired" | "disconnected"; expiresAt?: string };
export const codexLoginHint = "Run 'porta login openai-codex' to sign in with your ChatGPT account.";
const storageError = () => failure("STORAGE_FAILED", "Cannot access private Codex credentials. Check the auth directory permissions and lock; credentials were not overwritten.");
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Private, atomic, cross-process locked token storage. Never imports another application's credentials. */
export class CodexCredentialStore {
  readonly directory: string;
  constructor(directory = process.env.PORTA_AUTH_DIR ?? join(process.env.PORTA_DATA_DIR ?? join(homedir(), ".porta"), "auth")) { this.directory = resolve(directory); }
  private get file(): string { return join(this.directory, "openai-codex.json"); }

  private async checkDirectory(create: boolean): Promise<boolean> {
    // POSIX modes do not enforce Windows ACLs: fail closed until an ACL/keychain backend exists.
    if (process.platform === "win32") throw storageError();
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const stat = await lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw storageError();
      return true;
    } catch (error) { if (!create && isMissing(error)) return false; throw storageError(); }
  }

  async read(signal?: AbortSignal): Promise<CodexCredential | undefined> {
    signal?.throwIfAborted();
    if (!await this.checkDirectory(false)) return undefined;
    try {
      const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw storageError();
        const buffer = Buffer.alloc(65537);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 65536) throw storageError();
        signal?.throwIfAborted();
        return credentialSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
      } finally { await handle.close(); }
    } catch (error) { signal?.throwIfAborted(); if (isMissing(error)) return undefined; throw storageError(); }
  }

  private async locked<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await this.checkDirectory(true);
    const lock = join(this.directory, "openai-codex.lock");
    const deadline = Date.now() + 10000;
    for (;;) {
      signal.throwIfAborted();
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw storageError();
        await delay(25, undefined, { signal });
      }
    }
    try { signal.throwIfAborted(); return await work(); }
    finally { await rmdir(lock); }
  }

  async modify(signal: AbortSignal, update: (current: CodexCredential | undefined) => Promise<OAuthCredential>): Promise<CodexCredential> {
    return this.locked(signal, async () => {
      const current = await this.read(signal);
      const next = credentialSchema.parse(await update(current));
      signal.throwIfAborted();
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > 65536) throw storageError();
      if (serialized === JSON.stringify(current)) return next;
      const temporary = join(this.directory, `.codex-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(serialized); await handle.sync(); }
        finally { await handle.close(); }
        signal.throwIfAborted();
        // All Porta writers hold the lock; also detect out-of-band edits during refresh.
        if (JSON.stringify(await this.read(signal)) !== JSON.stringify(current)) throw storageError();
        await rename(temporary, this.file);
        await this.syncDirectory();
        return next;
      } finally { await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw storageError(); }); }
    });
  }

  async delete(signal: AbortSignal): Promise<void> {
    if (!await this.checkDirectory(false)) return;
    await this.locked(signal, async () => { await this.read(signal); await unlink(this.file).catch((error: unknown) => { if (!isMissing(error)) throw storageError(); }); await this.syncDirectory(); });
  }

  private async syncDirectory(): Promise<void> {
    const handle = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

export class CodexAuth implements CodexAuthSource {
  private readonly oauth: OAuthAuth;
  constructor(readonly store = new CodexCredentialStore(), oauth?: OAuthAuth) {
    this.oauth = oauth ?? openaiCodexProvider().auth.oauth!;
  }
  async login(interaction: AuthInteraction): Promise<void> {
    const signal = interaction.signal ?? AbortSignal.timeout(15 * 60 * 1000);
    try {
      const credential = await this.oauth.login({ ...interaction, signal });
      await this.store.modify(signal, async () => credential);
    } catch { signal.throwIfAborted(); throw failure("AUTHORIZATION_DENIED", `Codex login failed. ${codexLoginHint}`); }
  }
  async logout(signal = AbortSignal.timeout(15000)): Promise<void> { await this.store.delete(signal); }
  async accountState(signal = AbortSignal.timeout(5000)): Promise<CodexAccountState> {
    try {
      const credential = await this.store.read(signal);
      if (!credential) return { status: "disconnected" };
      return { status: credential.expires > Date.now() ? "connected" : "expired", expiresAt: new Date(credential.expires).toISOString() };
    } catch { signal.throwIfAborted(); return { status: "disconnected" }; }
  }
  async getAccess(signal: AbortSignal): Promise<CodexAccess> {
    try {
      const stored = await this.store.read(signal);
      if (!stored) throw new Error("Missing credentials");
      const credential = stored.expires > Date.now() + 60000 ? stored : await this.store.modify(signal, async (current) => {
        if (!current) throw new Error("Logged out");
        return current.expires > Date.now() + 60000 ? current : this.oauth.refresh(current, signal);
      });
      signal.throwIfAborted();
      return { access: credential.access, accountId: credential.accountId };
    } catch { signal.throwIfAborted(); throw failure("AUTHORIZATION_DENIED", `Codex credentials are missing, unreadable, or could not be refreshed. ${codexLoginHint}`); }
  }
}

export type CodexWebLoginState = "disconnected" | "starting" | "awaiting_user" | "connected" | "expired" | "failed" | "cancelled";
export interface CodexWebLoginSnapshot { id?: string; status: CodexWebLoginState; authorization?: { kind: "url"; url: string; instructions?: string } | { kind: "device_code"; verificationUri: string; userCode: string; instructions?: string }; error?: string; expiresAt?: string }

/** Web orchestration for the same CodexAuth used by the CLI; it never exposes credentials. */
export class CodexWebAuthService {
  private pending?: { snapshot: CodexWebLoginSnapshot; controller: AbortController; promise: Promise<void> };
  private last: CodexWebLoginSnapshot = { status: "disconnected" };
  constructor(readonly auth = new CodexAuth()) {}
  async status(): Promise<CodexWebLoginSnapshot> {
    if (this.pending) return { ...this.pending.snapshot };
    const account = await this.auth.accountState();
    if (account.status === "connected") return { status: "connected", expiresAt: account.expiresAt };
    if (account.status === "expired") return { status: "expired", expiresAt: account.expiresAt };
    return this.last.status === "failed" || this.last.status === "cancelled" ? { ...this.last } : { status: "disconnected" };
  }
  startLogin(method: "browser" | "device_code" = "device_code"): CodexWebLoginSnapshot {
    if (this.pending) return { ...this.pending.snapshot };
    const id = randomUUID(); const controller = new AbortController();
    const snapshot: CodexWebLoginSnapshot = { id, status: "starting" };
    const pending = { snapshot, controller, promise: Promise.resolve() };
    this.pending = pending; this.last = snapshot;
    pending.promise = this.auth.login({
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60 * 1000)]),
      async prompt(prompt) { if (prompt.type === "select") return method; throw failure("CANCELLED", "Codex login requires user authorization."); },
      notify: (event) => {
        if (event.type === "auth_url") pending.snapshot = { ...pending.snapshot, status: "awaiting_user", authorization: { kind: "url", url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) } };
        else if (event.type === "device_code") pending.snapshot = { ...pending.snapshot, status: "awaiting_user", authorization: { kind: "device_code", verificationUri: event.verificationUri, userCode: event.userCode } };
      },
    }).then(async () => { const account = await this.auth.accountState(); pending.snapshot = { id, status: account.status === "connected" ? "connected" : "expired", ...(account.expiresAt ? { expiresAt: account.expiresAt } : {}) }; this.last = pending.snapshot; }).catch(() => { pending.snapshot = { id, status: controller.signal.aborted ? "cancelled" : "failed", error: controller.signal.aborted ? "Login cancelled." : "Codex login failed." }; this.last = pending.snapshot; }).finally(() => { if (this.pending?.snapshot.id === id) this.pending = undefined; });
    return { ...snapshot };
  }
  async loginStatus(id: string): Promise<CodexWebLoginSnapshot> { if (this.pending?.snapshot.id === id) return { ...this.pending.snapshot }; if (this.last.id === id) return { ...this.last }; return this.status(); }
  async disconnect(): Promise<void> { this.pending?.controller.abort(); await this.pending?.promise.catch(() => {}); await this.auth.logout(); this.last = { status: "disconnected" }; }
}
