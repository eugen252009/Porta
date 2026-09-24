import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCredentialStore } from "../src/git-credentials.js";
import { CliGitBackend } from "../src/git.js";
import { SessionWorkspaceManager, validateGitRemote } from "../src/session-workspaces.js";
import type { ProcessRunRequest, ProcessRunResult, ProcessRunner } from "../src/process-runner.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const sessionA = "11111111-1111-4111-8111-111111111111";
const sessionB = "22222222-2222-4222-8222-222222222222";
const sessionC = "33333333-3333-4333-8333-333333333333";
const dirs: string[] = [];
function dataDir() { const path = mkdtempSync(join(tmpdir(), "porta-workspaces-test-")); dirs.push(path); return path; }
function result(exitCode = 0, stderr = ""): ProcessRunResult { return { status: "completed", exitCode, stdout: "", stderr, stdoutTruncated: false, stderrTruncated: false }; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))); });

describe("session-scoped workspaces", () => {
  it("isolates sessions, persists ownership, and supports keep/reopen/delete", async () => {
    const data = dataDir(); const manager = new SessionWorkspaceManager(data); await manager.initialize();
    const [first, duplicate] = await Promise.all([manager.createForSession(sessionA), manager.createForSession(sessionA)]);
    expect(first.workspaceId).toBe(duplicate.workspaceId);
    const firstPath = await manager.workspaceForSession(sessionA); await fs.mkdir(join(firstPath, "src")); await fs.writeFile(join(firstPath, "src", "work.txt"), "session A only");
    const secondPath = await manager.workspaceForSession(sessionB);
    expect(firstPath).not.toBe(secondPath); await expect(fs.stat(join(secondPath, "src", "work.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const saved = await manager.deleteSessionWorkspace(sessionA, "keep"); expect(saved.savedProjectId).toBe(first.workspaceId);
    const restoredManager = new SessionWorkspaceManager(data); await restoredManager.initialize();
    expect((await restoredManager.savedProjects()).map((project) => project.workspaceId)).toContain(first.workspaceId);
    const reopened = await restoredManager.createForSession(sessionC, { savedProjectId: first.workspaceId });
    expect(reopened.workspaceId).toBe(first.workspaceId); expect(await fs.readFile(join(await restoredManager.workspaceForSession(sessionC), "src", "work.txt"), "utf8")).toBe("session A only");
    await restoredManager.deleteSessionWorkspace(sessionC, "delete");
    await expect(fs.stat(join(firstPath, "src", "work.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await restoredManager.savedProjects()).toEqual([]);
    await expect(restoredManager.createForSession("../../outside")).rejects.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(statSync(join(data, "workspaces.json")).mode & 0o777).toBe(0o600);
  });

  it("passes supported remote URLs as literal argv, bounds setup, and cleans failed clones", async () => {
    const requests: ProcessRunRequest[] = []; const runner: ProcessRunner = { async run(request) { requests.push(request); return result(); } };
    const manager = new SessionWorkspaceManager(dataDir(), runner); await manager.initialize();
    const summary = await manager.createForSession(sessionA, { repository: "nas:/srv/repos/demo.git" });
    const request = requests[0]!;
    expect(request.args).toEqual(["-c", "core.hooksPath=/dev/null", "clone", "--no-recurse-submodules", "--", "nas:/srv/repos/demo.git", join(manager.root, `.setup-${summary.workspaceId}`)]);
    expect(request.cwd).toBe(manager.root); expect(request.environment).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_VALUE_0: "/dev/null", GIT_CONFIG_VALUE_2: "never" });
    expect(validateGitRemote("file:///srv/repos/demo.git")).toBe("file:///srv/repos/demo.git");
    expect(validateGitRemote("https://git.example/org/demo.git")).toBe("https://git.example/org/demo.git");
    expect(validateGitRemote("nas:/srv/repos/demo.git")).toBe("nas:/srv/repos/demo.git");
    expect(validateGitRemote("eugen@nas:/srv/repos/demo.git")).toBe("eugen@nas:/srv/repos/demo.git");
    expect(validateGitRemote("ssh://eugen@nas/srv/repos/demo.git")).toBe("ssh://eugen@nas/srv/repos/demo.git");
    expect(() => validateGitRemote("https://user:token@git.example/org/demo.git")).toThrow(/Do not put credentials/);
    expect(() => validateGitRemote("ssh://git:password@git.example/org/demo.git")).toThrow(/Do not put credentials/);
    expect(() => validateGitRemote("--upload-pack=evil")).toThrow();

    const failingRunner: ProcessRunner = { async run(request) { return request.signal.aborted ? { status: "cancelled", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false } : result(128, "fatal: unable to access https://u:secret@example.invalid/repo: failed"); } };
    const failedManager = new SessionWorkspaceManager(dataDir(), failingRunner); await failedManager.initialize();
    await expect(failedManager.createForSession(sessionB, { repository: "https://example.invalid/repo.git" })).rejects.toMatchObject({ error: { code: "CAPABILITY_UNAVAILABLE" } });
    expect(await failedManager.activeWorkspaces()).toEqual([]);
    expect((await fs.readdir(failedManager.root))).toEqual([]);
    await expect(failedManager.createForSession("cancelled-session", { repository: "ssh://git.example/repo.git", signal: AbortSignal.abort() })).rejects.toMatchObject({ error: { code: "CANCELLED" } });
  });

  it("does not follow a replaced workspace symlink during deletion", async () => {
    const data = dataDir(); const manager = new SessionWorkspaceManager(data); await manager.initialize();
    const created = await manager.createForSession(sessionA); const path = join(manager.root, created.workspaceId); const external = join(data, "external"); await fs.mkdir(external); await fs.writeFile(join(external, "keep.txt"), "safe");
    await fs.rm(path, { recursive: true }); await fs.symlink(external, path);
    await expect(manager.deleteSessionWorkspace(sessionA, "delete")).rejects.toMatchObject({ error: { code: "POLICY_VIOLATION" } });
    expect(await fs.readFile(join(external, "keep.txt"), "utf8")).toBe("safe");
  });
});

describe("server-managed Git credentials", () => {
  it("injects assigned credentials only into isolated remote fetches", async () => {
    const root = dataDir(); const repoRoot = join(root, "repo"); await fs.mkdir(repoRoot);
    const store = new GitCredentialStore(join(root, "data")); await store.initialize();
    const credential = await store.create({ name: "Fetch token", type: "https", scope: "global", username: "user", password: "fetch-secret" });
    const calls: ProcessRunRequest[] = []; const runner: ProcessRunner = { async run(request) { calls.push(request); return calls.length === 1 ? { ...result(), stdout: "https://git.example/org/repo.git\\n" } : result(); } };
    const backend = new CliGitBackend({ root: repoRoot, credentialEnvironment: (context, remote) => store.resolveForClone(context.sessionId!, [credential.id], remote) }, runner);
    await backend.fetch({ signal: new AbortController().signal, sessionId: sessionA });
    expect(calls.map((call) => call.args)).toEqual([["remote", "get-url", "origin"], ["fetch", "--no-recurse-submodules"]]);
    const environment = calls[1]!.environment; expect(environment.GIT_CONFIG_COUNT).toBe("16"); expect(environment.GIT_CONFIG_VALUE_11).toBe(""); expect(environment.GIT_CONFIG_VALUE_12).toBe(""); expect(environment.GIT_CONFIG_VALUE_13).toBe("");
    expect(environment.GIT_ASKPASS).toMatch(/porta-git-/); expect(JSON.stringify(environment)).not.toContain("fetch-secret");
    await expect(fs.stat(environment.GIT_ASKPASS!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("stores secrets privately, requires explicit assignment, and keeps SSH host verification strict", async () => {
    const data = dataDir(); const store = new GitCredentialStore(data); await store.initialize();
    const https = await store.create({ name: "CI token", type: "https", scope: "global", username: "token-user", password: "never-return-this" });
    const serialized = JSON.stringify(https); expect(serialized).not.toContain("never-return-this");
    expect(statSync(join(store.root, https.id)).mode & 0o777).toBe(0o700);
    expect(statSync(join(store.root, https.id, "password")).mode & 0o777).toBe(0o600);
    const unassignedHttps = await store.resolveForClone(sessionA, [], "https://git.example/org/repo.git"); expect(unassignedHttps?.environment).not.toHaveProperty("GIT_ASKPASS"); await unassignedHttps?.cleanup?.();
    const selected = await store.resolveForClone(sessionA, [https.id], "https://git.example/org/repo.git");
    expect(selected?.environment).toHaveProperty("GIT_ASKPASS");
    expect(JSON.stringify(selected?.environment)).not.toContain("never-return-this");
    const askpass = selected!.environment.GIT_ASKPASS!;
    const correctHostPrompt = spawnSync(process.execPath, [askpass, "Password for 'https://git.example/org/repo.git':"], { encoding: "utf8" });
    const otherHostPrompt = spawnSync(process.execPath, [askpass, "Password for 'https://evil.example/org/repo.git':"], { encoding: "utf8" });
    expect(correctHostPrompt.status).toBe(0); expect(correctHostPrompt.stdout).toBe("never-return-this"); expect(otherHostPrompt.status).toBe(1); expect(otherHostPrompt.stdout).toBe("");
    const secretFile = join(dirname(askpass), "password"); expect(readFileSync(secretFile, "utf8")).toBe("never-return-this");
    await selected?.cleanup?.(); await expect(fs.stat(secretFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.resolveForClone(sessionA, [https.id], "https://user:token@git.example/repo.git")).rejects.toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const ssh = await store.create({ name: "SSH deploy key", type: "ssh", scope: "session", sessionId: sessionA, privateKey: "PRIVATE KEY MATERIAL", publicKey: "ssh-ed25519 AAAA", knownHosts: "git.example ssh-ed25519 AAAA", sshConfig: "Host git.example\n  HostName git.example\n  User git\n  Port 22" });
    await expect(store.validateAssignments(sessionB, [ssh.id])).rejects.toMatchObject({ error: { code: "AUTHORIZATION_DENIED" } });
    await expect(store.create({ name: "Unsafe config", type: "ssh", scope: "global", privateKey: "key", knownHosts: "host key", sshConfig: "Host *\n  ProxyCommand curl evil" })).rejects.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    const sshEnv = await store.resolveForClone(sessionA, [ssh.id], "git@git.example:org/repo.git");
    expect(sshEnv?.environment.GIT_SSH_COMMAND).toMatch(/^ssh -F \/tmp\/porta-git-/);
    expect(sshEnv?.environment.GIT_SSH_COMMAND).not.toContain("PRIVATE KEY MATERIAL");
    const config = readFileSync(sshEnv!.environment.GIT_SSH_COMMAND!.split(" ").at(-1)!, "utf8");
    expect(config).toContain("StrictHostKeyChecking yes"); expect(config).toContain("IdentitiesOnly yes"); expect(config).toContain("UserKnownHostsFile"); expect(config.toLowerCase()).toContain("hostname git.example");
    await sshEnv?.cleanup?.();
    const sshUrlEnv = await store.resolveForClone(sessionA, [ssh.id], "ssh://git@git.example/org/repo.git");
    const sshUrlConfig = readFileSync(sshUrlEnv!.environment.GIT_SSH_COMMAND!.split(" ").at(-1)!, "utf8");
    expect(sshUrlConfig).toContain("Host git.example"); expect(sshUrlConfig).toContain("StrictHostKeyChecking yes");
    await sshUrlEnv?.cleanup?.();
    const uncredentialedSsh = await store.resolveForClone(sessionB, [], "ssh://git.example/org/repo.git"); expect(uncredentialedSsh?.environment.GIT_SSH_COMMAND).toContain("porta-git-"); await uncredentialedSsh?.cleanup?.();
    await store.deleteSessionCredentials(sessionA); expect(await store.listForSession(sessionA)).toEqual([https]);
    expect(await store.listForSession(sessionB)).toEqual([https]);
  });
});
