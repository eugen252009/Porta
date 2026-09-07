import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthInteraction, OAuthAuth } from "@earendil-works/pi-ai";
import { CodexAuth, CodexCredentialStore, type CodexCredential } from "../src/adapters/codex-auth.js";
import { runCodexAuthCommand } from "../src/codex-auth-cli.js";

const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), "porta-auth-")); roots.push(root); return { root, store: new CodexCredentialStore(join(root, "auth")) }; }
const signal = () => new AbortController().signal;
const credential = (expires = Date.now() + 3600000): CodexCredential => ({ type: "oauth", access: "secret-access", refresh: "secret-refresh", expires, accountId: "account" });
const interaction: AuthInteraction = { prompt: async () => "browser", notify: () => {} };
function oauth(overrides: Partial<OAuthAuth> = {}): OAuthAuth {
  return { name: "mock", login: async () => credential(), refresh: async () => credential(), toAuth: async (value) => ({ apiKey: value.access }), ...overrides };
}
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("private Codex credentials", () => {
  it("does not create storage on construction, read, or unauthenticated generation", async () => {
    const { root, store } = await fixture();
    expect(await store.read()).toBeUndefined();
    await expect(new CodexAuth(store, oauth()).getAccess(signal())).rejects.toMatchObject({ error: { code: "AUTHORIZATION_DENIED", message: expect.stringContaining("porta login openai-codex") } });
    expect(await readdir(root)).toEqual([]);
    await new CodexAuth(store, oauth()).logout();
    expect(await readdir(root)).toEqual([]);
  });

  it("persists login atomically with private modes and reads it after restart", async () => {
    const { store } = await fixture();
    await new CodexAuth(store, oauth()).login(interaction);
    expect((await lstat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(store.directory, "openai-codex.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(store.directory)).toEqual(["openai-codex.json"]);
    const refresh = vi.fn();
    const restarted = new CodexAuth(new CodexCredentialStore(store.directory), oauth({ refresh }));
    expect(await restarted.getAccess(signal())).toEqual({ access: "secret-access", accountId: "account" });
    expect(refresh).not.toHaveBeenCalled();
    await restarted.logout();
    expect(await store.read()).toBeUndefined();
  });

  it("serializes concurrent token refresh across independent store instances", async () => {
    const { store } = await fixture(); await store.modify(signal(), async () => credential(0));
    const refresh = vi.fn(async () => ({ ...credential(), access: "rotated-access", refresh: "rotated-refresh" }));
    const first = new CodexAuth(store, oauth({ refresh }));
    const second = new CodexAuth(new CodexCredentialStore(store.directory), oauth({ refresh }));
    const result = await Promise.all([first.getAccess(signal()), second.getAccess(signal()), first.getAccess(signal())]);
    expect(result.every((item) => item.access === "rotated-access")).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(await store.read()).toMatchObject({ refresh: "rotated-refresh" });
  });

  it("preserves existing credentials on refresh/login failure without leaking secrets", async () => {
    const { store } = await fixture(); const saved = credential(0); await store.modify(signal(), async () => saved);
    const fail = async () => { throw new Error("secret-access secret-refresh server response"); };
    const auth = new CodexAuth(store, oauth({ refresh: fail, login: fail }));
    for (const operation of [() => auth.getAccess(signal()), () => auth.login(interaction)]) {
      await expect(operation()).rejects.toMatchObject({ error: { code: "AUTHORIZATION_DENIED", message: expect.not.stringContaining("secret-") } });
      expect(await store.read()).toEqual(saved);
    }
    expect(await readdir(store.directory)).toEqual(["openai-codex.json"]);
  });

  it("detects out-of-band edits during refresh instead of overwriting changed credentials", async () => {
    const { store } = await fixture(); await store.modify(signal(), async () => credential(0));
    const edited = { ...credential(), access: "external-access" };
    const auth = new CodexAuth(store, oauth({ refresh: async () => {
      await writeFile(join(store.directory, "openai-codex.json"), JSON.stringify(edited), { mode: 0o600 });
      return credential();
    } }));
    await expect(auth.getAccess(signal())).rejects.toMatchObject({ error: { code: "AUTHORIZATION_DENIED" } });
    expect(await store.read()).toEqual(edited);
    expect(await readdir(store.directory)).toEqual(["openai-codex.json"]);
  });

  it("rejects oversized credentials before replacing the saved file", async () => {
    const { store } = await fixture(); const saved = credential(); await store.modify(signal(), async () => saved);
    await expect(store.modify(signal(), async () => ({ ...saved, access: "x".repeat(65537) }))).rejects.toMatchObject({ error: { code: "STORAGE_FAILED" } });
    expect(await store.read()).toEqual(saved);
  });

  it("does not resurrect credentials when logout races a refresh", async () => {
    const { store } = await fixture(); await store.modify(signal(), async () => credential(0));
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const auth = new CodexAuth(store, oauth({ refresh: async () => { started(); await gate; return credential(); } }));
    const pending = auth.getAccess(signal()); await entered;
    const logout = new CodexAuth(new CodexCredentialStore(store.directory), oauth()).logout();
    release(); await pending; await logout;
    expect(await store.read()).toBeUndefined();
  });

  it("cancels a locked operation and never steals a potentially live lock", async () => {
    const { store } = await fixture(); await store.modify(signal(), async () => credential(0));
    await mkdir(join(store.directory, "openai-codex.lock"));
    const control = new AbortController();
    const pending = new CodexAuth(store, oauth()).getAccess(control.signal); control.abort();
    await expect(pending).rejects.toThrow();
    expect((await lstat(join(store.directory, "openai-codex.lock"))).isDirectory()).toBe(true);
    expect((await store.read())?.expires).toBe(0);
  });

  it("propagates cancellation during refresh and releases the lock", async () => {
    const { store } = await fixture(); const saved = credential(0); await store.modify(signal(), async () => saved);
    const control = new AbortController();
    const refresh = vi.fn(async (_value, refreshSignal: AbortSignal) => { control.abort(); refreshSignal.throwIfAborted(); return credential(); });
    await expect(new CodexAuth(store, oauth({ refresh })).getAccess(control.signal)).rejects.toThrow();
    expect(refresh).toHaveBeenCalledOnce(); expect(await store.read()).toEqual(saved);
    expect(await readdir(store.directory)).toEqual(["openai-codex.json"]);
  });

  it.each(["malformed", "oversized", "insecure", "symlink"])("fails closed for %s credential files without overwriting", async (kind) => {
    const { root, store } = await fixture(); await mkdir(store.directory, { mode: 0o700 });
    const file = join(store.directory, "openai-codex.json");
    const content = kind === "oversized" ? "x".repeat(65537) : kind === "malformed" ? '{"access":"secret-access"}' : JSON.stringify(credential());
    if (kind === "symlink") { await writeFile(join(root, "outside"), content, { mode: 0o600 }); await symlink(join(root, "outside"), file); }
    else { await writeFile(file, content, { mode: 0o600 }); if (kind === "insecure") await chmod(file, 0o644); }
    await expect(store.read()).rejects.toMatchObject({ error: { code: "STORAGE_FAILED" } });
    await expect(new CodexAuth(store, oauth()).login(interaction)).rejects.toMatchObject({ error: { code: "AUTHORIZATION_DENIED" } });
    expect(await readFile(file, "utf8")).toBe(content);
  });

  it.each(["insecure", "symlink"])("rejects a %s auth directory", async (kind) => {
    const { root, store } = await fixture();
    if (kind === "insecure") { await mkdir(store.directory); await chmod(store.directory, 0o755); }
    else { await mkdir(join(root, "target"), { mode: 0o700 }); await symlink(join(root, "target"), store.directory); }
    await expect(store.read()).rejects.toMatchObject({ error: { code: "STORAGE_FAILED" } });
  });
});

describe("Codex auth commands", () => {
  it("ignores non-auth commands and rejects malformed auth arguments", async () => {
    const auth = { login: vi.fn(), logout: vi.fn() };
    expect(await runCodexAuthCommand(["--session", "test"], { auth })).toBe(false);
    for (const args of [["login"], ["login", "openai"], ["logout", "openai-codex", "--device-code"], ["login", "openai-codex", "--token", "secret"]]) {
      await expect(runCodexAuthCommand(args, { auth })).rejects.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    }
    expect(auth.login).not.toHaveBeenCalled(); expect(auth.logout).not.toHaveBeenCalled();
  });

  it.each([false, true])("performs explicit login (device=%s) and prints no credentials", async (device) => {
    const write = vi.fn(); const notify = vi.fn();
    const auth = { login: vi.fn(async (ui: AuthInteraction) => {
      expect(await ui.prompt({ type: "select", message: "method", options: [] })).toBe(device ? "device_code" : "browser");
      ui.notify({ type: "auth_url", url: "https://example.test/login" });
    }), logout: vi.fn() };
    const before = process.listenerCount("SIGINT");
    expect(await runCodexAuthCommand(["login", "openai-codex", ...(device ? ["--device-code"] : [])], { auth, write, interaction: { ...interaction, notify } })).toBe(true);
    expect(notify).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledWith("Signed in to OpenAI Codex.\n");
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("rejects non-loopback callback configuration before starting browser login", async () => {
    vi.stubEnv("PI_OAUTH_CALLBACK_HOST", "0.0.0.0");
    const auth = { login: vi.fn(), logout: vi.fn() };
    await expect(runCodexAuthCommand(["login", "openai-codex"], { auth })).rejects.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(auth.login).not.toHaveBeenCalled();
  });

  it("logs out explicitly and sanitizes failures", async () => {
    const write = vi.fn(); const auth = { login: vi.fn(), logout: vi.fn(async () => {}) };
    expect(await runCodexAuthCommand(["logout", "openai-codex"], { auth, write })).toBe(true);
    expect(auth.logout).toHaveBeenCalledOnce();
    auth.logout.mockRejectedValueOnce(new Error("secret-token"));
    await expect(runCodexAuthCommand(["logout", "openai-codex"], { auth, write })).rejects.toMatchObject({ error: { message: expect.not.stringContaining("secret-token") } });
  });

  it("runs the actual dependency's device login and refresh with mocked HTTP only", async () => {
    const { store } = await fixture();
    const jwt = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "device-account" } })).toString("base64")}.signature`;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      expect(path.startsWith("https://auth.openai.com/")).toBe(true);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (path.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "device", user_code: "ABCD", interval: "0" });
      if (path.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier", code_challenge: "challenge" });
      if (path.endsWith("/oauth/token")) return Response.json({ access_token: jwt, refresh_token: "device-refresh", expires_in: 3600 });
      throw new Error("Unexpected URL");
    });
    vi.stubGlobal("fetch", fetch);
    const auth = new CodexAuth(store); const notify = vi.fn();
    await runCodexAuthCommand(["login", "openai-codex", "--device-code"], { auth, write: () => {}, interaction: { ...interaction, notify } });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "device_code", userCode: "ABCD" }));
    expect(await auth.getAccess(signal())).toEqual({ access: jwt, accountId: "device-account" });
    await store.modify(signal(), async (current) => ({ ...current!, expires: 0 }));
    await auth.getAccess(signal());
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(String(fetch.mock.calls.at(-1)?.[1]?.body)).toContain("grant_type=refresh_token");
  });
});
