import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyGithubSshVerification, deriveEd25519SshPublicKey, ed25519SshFingerprint, generateEd25519SshKeyPair, sshKeyFingerprint } from "../src/github-ssh.js";
import { GitCredentialStore } from "../src/git-credentials.js";
import { CliGitBackend, GitToolProvider } from "../src/git.js";
import { SessionWorkspaceManager } from "../src/session-workspaces.js";
import type { ProcessRunRequest, ProcessRunResult, ProcessRunner } from "../src/process-runner.js";

const sessionId = "aaf54a11-5c64-4ded-b4ca-54b0b91fd27d";
const sshKeygenAvailable = spawnSync("ssh-keygen", ["-V"], { stdio: "ignore" }).status !== null;
const roots: string[] = [];
function root() { const value = mkdtempSync(join(tmpdir(), "porta-github-ssh-test-")); roots.push(value); return value; }
function processResult(exitCode = 0, stdout = "", stderr = ""): ProcessRunResult { return { status: "completed", exitCode, stdout, stderr, stdoutTruncated: false, stderrTruncated: false }; }
function runnerFor(result: ProcessRunResult, requests: ProcessRunRequest[] = []): ProcessRunner { return { async run(request) { requests.push(request); return result; } }; }
async function trustedHosts(data: string) { const path = join(data, "trusted_known_hosts"); await fs.writeFile(path, "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureTrustedGithubHostKey\n", { mode: 0o600 }); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true }))); });

describe("GitHub Ed25519 key lifecycle", () => {
  it("generates an OpenSSH-compatible Ed25519 pair with a stable public fingerprint", () => {
    const pair = generateEd25519SshKeyPair();
    expect(pair.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(pair.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(pair.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(ed25519SshFingerprint(pair.publicKey)).toBe(pair.fingerprint);
    expect(ed25519SshFingerprint("ssh-ed25519 not-a-key")).toBeUndefined();
    expect(deriveEd25519SshPublicKey(pair.privateKey)?.publicKey.split(" ").slice(0, 2)).toEqual(pair.publicKey.split(" ").slice(0, 2));
    expect(deriveEd25519SshPublicKey(pair.privateKey)?.fingerprint).toBe(pair.fingerprint);
    expect(generateEd25519SshKeyPair().fingerprint).not.toBe(pair.fingerprint);
    const temp = root(); const privatePath = join(temp, "identity"); writeFileSync(privatePath, pair.privateKey, { mode: 0o600 });
    if (spawnSync("ssh-keygen", ["-y", "-f", privatePath], { encoding: "utf8" }).status === 0) {
      const derived = spawnSync("ssh-keygen", ["-y", "-f", privatePath], { encoding: "utf8" });
      expect(derived.stdout.trim().split(" ").slice(0, 2).join(" ")).toBe(pair.publicKey.split(" ").slice(0, 2).join(" "));
    }
  });

  it("does not replace an existing GitHub credential without explicit rotation", async () => {
    const data = root(); const hosts = await trustedHosts(data); const store = new GitCredentialStore(join(data, "vault"), { githubKnownHostsFile: hosts }); await store.initialize();
    const legacyPair = generateEd25519SshKeyPair();
    const legacy = await store.create({ name: "GitHub", type: "ssh", scope: "global", privateKey: legacyPair.privateKey, knownHosts: "github.com ssh-ed25519 trusted\n", sshConfig: "User git" });
    const existing = await store.githubSshKey();
    expect(existing).toMatchObject({ id: legacy.id, fingerprint: legacyPair.fingerprint });
    expect(existing?.publicKey?.split(" ").slice(0, 2)).toEqual(legacyPair.publicKey.split(" ").slice(0, 2));
    const noOp = await store.createGithubSshKey();
    expect(noOp.created).toBe(false); expect(noOp.credential.id).toBe(legacy.id);
    expect(await store.listForSession(sessionId)).toHaveLength(1);
    const rotated = await store.createGithubSshKey(true);
    expect(rotated.created).toBe(true); expect(rotated.credential.id).not.toBe(legacy.id);
    expect(rotated.credential.fingerprint).not.toBe(legacyPair.fingerprint);
    expect(await store.githubSshKey()).toMatchObject({ id: rotated.credential.id });
    expect(await store.listForSession(sessionId)).toHaveLength(2);
  });

  it.skipIf(!sshKeygenAvailable)("derives public metadata from a pre-existing OpenSSH-format private key", async () => {
    const data = root(); const generatedPath = join(data, "legacy_identity");
    const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "legacy-github", "-f", generatedPath], { encoding: "utf8" });
    if (generated.status !== 0) return;
    const privateKey = readFileSync(generatedPath, "utf8"); const expectedPublicKey = readFileSync(`${generatedPath}.pub`, "utf8").trim();
    const store = new GitCredentialStore(join(data, "vault")); await store.initialize();
    await store.create({ name: "GitHub old key", type: "ssh", scope: "global", privateKey, knownHosts: "github.com ssh-ed25519 trusted\\n" });
    const summary = await store.githubSshKey();
    expect(summary?.publicKey?.split(" ").slice(0, 2)).toEqual(expectedPublicKey.split(" ").slice(0, 2));
    expect(summary?.fingerprint).toBe(sshKeyFingerprint(expectedPublicKey));
    expect(JSON.stringify(summary)).not.toContain(privateKey);
  });

  it("stores generated private material with restrictive permissions and returns public metadata only", async () => {
    const data = root(); const hosts = await trustedHosts(data); const store = new GitCredentialStore(join(data, "vault"), { githubKnownHostsFile: hosts }); await store.initialize();
    const result = await store.createGithubSshKey(); const credential = result.credential;
    const privatePath = join(store.root, credential.id, "private-key"); const privateKey = readFileSync(privatePath, "utf8");
    expect(result.created).toBe(true); expect(credential).toMatchObject({ type: "ssh", scope: "global", provider: "github" });
    expect(statSync(store.root).mode & 0o777).toBe(0o700); expect(statSync(join(store.root, credential.id)).mode & 0o777).toBe(0o700); expect(statSync(privatePath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain(privateKey); expect(readFileSync(join(store.root, credential.id, "metadata.json"), "utf8")).not.toContain(privateKey);
    expect(credential.publicKey).toMatch(/^ssh-ed25519 /); expect(credential.fingerprint).toBe(ed25519SshFingerprint(credential.publicKey!));
    expect(await store.githubSshKey()).toMatchObject({ id: credential.id, fingerprint: credential.fingerprint, publicKey: credential.publicKey });
    const duplicate = await store.createGithubSshKey(); expect(duplicate.created).toBe(false); expect(duplicate.credential.id).toBe(credential.id); expect(readFileSync(privatePath, "utf8")).toBe(privateKey);
    await expect(store.createGithubSshKey(true)).resolves.toMatchObject({ created: true });
    const current = await store.githubSshKey(); expect(current?.id).not.toBe(credential.id); expect(readFileSync(privatePath, "utf8")).toBe(privateKey);
    const previousAssignment = await store.resolveForClone(sessionId, [credential.id], "git@github.com:team/project.git");
    const previousConfigPath = previousAssignment!.environment.GIT_SSH_COMMAND!.slice("ssh -F ".length);
    const previousConfig = readFileSync(previousConfigPath, "utf8"); const previousIdentityPath = /IdentityFile ([^\n]+)/.exec(previousConfig)?.[1];
    expect(readFileSync(previousIdentityPath!, "utf8")).toBe(privateKey); await previousAssignment?.cleanup?.();
  });

  it("requires trusted host-key configuration before generating and reports a missing key distinctly", async () => {
    const data = root(); const runnerRequests: ProcessRunRequest[] = []; const store = new GitCredentialStore(join(data, "vault"), { githubKnownHostsFile: join(data, "missing_known_hosts"), processRunner: runnerFor(processResult(0, "Hi fixture! You've successfully authenticated, but GitHub does not provide shell access.\n"), runnerRequests) }); await store.initialize();
    await expect(store.createGithubSshKey()).rejects.toMatchObject({ error: { code: "CAPABILITY_UNAVAILABLE" } });
    expect(await store.githubSshKey()).toBeUndefined(); expect(await store.verifyGithubSshKey()).toEqual({ status: "key-missing" }); expect(runnerRequests).toHaveLength(0);
  });

  it("verifies a detected legacy GitHub key only with administrator-trusted host keys and ignores its custom SSH mapping", async () => {
    const data = root(); const hosts = await trustedHosts(data); const pair = generateEd25519SshKeyPair(); let capturedConfig = ""; let capturedHosts = "";
    const runner: ProcessRunner = { async run(request) { capturedConfig = readFileSync(request.args[1]!, "utf8"); const knownHostsPath = /UserKnownHostsFile ([^\n]+)/.exec(capturedConfig)?.[1]; capturedHosts = readFileSync(knownHostsPath!, "utf8"); return processResult(1, "Hi fixture! You've successfully authenticated, but GitHub does not provide shell access.\\n"); } };
    const store = new GitCredentialStore(join(data, "vault"), { githubKnownHostsFile: hosts, processRunner: runner }); await store.initialize();
    await store.create({ name: "GitHub legacy", type: "ssh", scope: "global", privateKey: pair.privateKey, knownHosts: "attacker.invalid ssh-ed25519 untrusted-user-key\\n", sshConfig: "HostName attacker.invalid" });
    expect(await store.verifyGithubSshKey()).toMatchObject({ status: "verified" });
    expect(capturedHosts).toContain("github.com ssh-ed25519"); expect(capturedHosts).not.toContain("attacker.invalid");
    expect(capturedConfig).not.toContain("HostName attacker.invalid");
  });

  it("classifies verification success, authentication, network, host-key, timeout, and cancellation separately", async () => {
    const cases: readonly { readonly result: ProcessRunResult; readonly expected: string }[] = [
      { result: processResult(1, "Hi fixture! You've successfully authenticated, but GitHub does not provide shell access.\n"), expected: "verified" },
      { result: processResult(255, "", "git@github.com: Permission denied (publickey).\n"), expected: "authentication-failed" },
      { result: processResult(255, "", "ssh: Could not resolve hostname github.com: Name or service not known\n"), expected: "network-error" },
      { result: processResult(255, "", "Host key verification failed.\n"), expected: "host-key-failed" },
      { result: { status: "timed-out", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }, expected: "network-error" },
      { result: { status: "cancelled", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }, expected: "cancelled" },
    ];
    for (const fixture of cases) expect(classifyGithubSshVerification(fixture.result)).toBe(fixture.expected);

    const data = root(); const hosts = await trustedHosts(data); const captured: ProcessRunRequest[] = [];
    let capturedConfig = "";
    const runner: ProcessRunner = { async run(request) { captured.push(request); capturedConfig = readFileSync(request.args[1]!, "utf8"); return processResult(1, "Hi fixture! You've successfully authenticated, but GitHub does not provide shell access.\n"); } };
    const store = new GitCredentialStore(join(data, "vault"), { githubKnownHostsFile: hosts, processRunner: runner }); await store.initialize();
    const created = await store.createGithubSshKey(); const privateKey = readFileSync(join(store.root, created.credential.id, "private-key"), "utf8");
    const verified = await store.verifyGithubSshKey();
    expect(verified).toMatchObject({ status: "verified", fingerprint: created.credential.fingerprint });
    expect(verified.verifiedAt).toBeDefined(); expect(captured).toHaveLength(1);
    expect(captured[0]?.args).toContain("-T"); expect(captured[0]?.args.at(-1)).toBe("git@github.com");
    expect(captured[0]?.deadline).toBeGreaterThan(Date.now());
    expect(captured[0]?.args[1]).toBeDefined();
    expect(capturedConfig).toContain("StrictHostKeyChecking yes"); expect(capturedConfig).toContain("UserKnownHostsFile"); expect(capturedConfig).toContain("GlobalKnownHostsFile /dev/null");
    expect(JSON.stringify(captured)).not.toContain(privateKey); expect(JSON.stringify(verified)).not.toContain(privateKey);
    expect((await store.githubSshKey())?.verifiedAt).toBe(verified.verifiedAt);
    const restarted = new GitCredentialStore(join(data, "vault"), { githubKnownHostsFile: hosts }); await restarted.initialize(); expect((await restarted.githubSshKey())?.verifiedAt).toBe(verified.verifiedAt);
  });

  it("honors verification cancellation and does not persist a false verified state", async () => {
    const data = root(); const hosts = await trustedHosts(data); let sawAbortedSignal = false;
    const runner: ProcessRunner = { async run(request) { sawAbortedSignal = request.signal.aborted; return { status: "cancelled", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }; } };
    const store = new GitCredentialStore(join(data, "vault"), { githubKnownHostsFile: hosts, processRunner: runner }); await store.initialize();
    await store.createGithubSshKey(); const controller = new AbortController(); controller.abort();
    expect(await store.verifyGithubSshKey(controller.signal)).toMatchObject({ status: "cancelled" });
    expect(sawAbortedSignal).toBe(true); expect((await store.githubSshKey())?.verifiedAt).toBeUndefined();
  });

  it("uses the generated credential for clone, fetch, and push, scopes it to GitHub, and reports semantic status", async () => {
    const data = root(); const hosts = await trustedHosts(data); const store = new GitCredentialStore(join(data, "vault"), { githubKnownHostsFile: hosts, processRunner: runnerFor(processResult(1, "Hi fixture! You've successfully authenticated, but GitHub does not provide shell access.\\n")) }); await store.initialize();
    const credential = (await store.createGithubSshKey()).credential; const privateKey = readFileSync(join(store.root, credential.id, "private-key"), "utf8");
    expect(await store.verifyGithubSshKey()).toMatchObject({ status: "verified" });
    await expect(store.resolveForClone(sessionId, [credential.id], "git@evil.example:org/repo.git")).rejects.toMatchObject({ error: { code: "AUTHORIZATION_DENIED" } });

    const cloneCalls: ProcessRunRequest[] = [];
    const cloneRunner: ProcessRunner = { async run(request) { cloneCalls.push(request); const command = request.environment.GIT_SSH_COMMAND; expect(command).toMatch(/^ssh -F /); const configPath = command!.slice("ssh -F ".length); const config = readFileSync(configPath, "utf8"); const identityPath = /IdentityFile ([^\n]+)/.exec(config)?.[1]; expect(config).toContain("Host github.com"); expect(config).toContain("StrictHostKeyChecking yes"); expect(identityPath).toBeDefined(); expect(statSync(identityPath!).mode & 0o777).toBe(0o600); expect(readFileSync(identityPath!, "utf8")).toBe(privateKey); return processResult(); } };
    const workspaces = new SessionWorkspaceManager(join(data, "workspace-data"), cloneRunner, store); await workspaces.initialize();
    await workspaces.createForSession(sessionId, { repository: "git@github.com:org/repo.git", credentialIds: [credential.id] }); expect(cloneCalls).toHaveLength(1); expect(cloneCalls[0]?.environment.GIT_SSH_COMMAND).toBeDefined();
    const cloneConfigPath = cloneCalls[0]!.environment.GIT_SSH_COMMAND!.slice("ssh -F ".length); await expect(fs.stat(cloneConfigPath)).rejects.toMatchObject({ code: "ENOENT" });

    const gitCalls: ProcessRunRequest[] = [];
    const gitRunner: ProcessRunner = { async run(request) { gitCalls.push(request); if (request.args[0] === "remote") return { ...processResult(), stdout: "git@github.com:org/repo.git\n" }; if (request.args[0] === "rev-parse") return { ...processResult(), stdout: "abcdef1234567890\n" }; return processResult(); } };
    const backend = new CliGitBackend({ root: await workspaces.workspaceForSession(sessionId), credentialEnvironment: (context, remote) => store.resolveForClone(context.sessionId!, [credential.id], remote), credentialStatus: (context) => store.describeAssignments(context.sessionId!, [credential.id]) }, gitRunner);
    const context = { signal: new AbortController().signal, sessionId };
    await backend.fetch(context); await backend.push(context);
    const authenticatedGitCalls = gitCalls.filter((request) => request.args[0] === "fetch" || request.args[0] === "push");
    expect(authenticatedGitCalls).toHaveLength(2); expect(authenticatedGitCalls.every((request) => request.environment.GIT_SSH_COMMAND?.includes("porta-git-"))).toBe(true);
    expect(JSON.stringify(authenticatedGitCalls.map((request) => request.environment))).not.toContain(privateKey);
    const provider = new GitToolProvider(backend); const status = await provider.invoke({ schemaVersion: 1, requestId: "credential-status", toolId: "credential_status", input: {} }, { traceId: "credential-status-test", sessionId, executionId: "credential-status-test", signal: new AbortController().signal });
    expect(status).toMatchObject({ ok: true, output: { configured: true, credentials: [{ provider: "SSH", host: "github.com", fingerprint: credential.fingerprint, verified: true }] } });
    expect(JSON.stringify(status)).not.toContain(privateKey);
  });
});
