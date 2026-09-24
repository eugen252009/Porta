import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedToolModelProvider } from "../src/agent-mocks.js";
import { createPortaApplication } from "../src/porta-application.js";
import { parsePortaConfig } from "../src/porta-config.js";
import { createPortaWebServer } from "../src/web-server.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const roots: string[] = [];
function temp() { const path = mkdtempSync(join(tmpdir(), "porta-workspace-web-")); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))); });

it.skipIf(!gitAvailable)("creates isolated API workspaces, saves/reopens them, and requires explicit file-deletion choice", async () => {
  const root = temp(); const source = join(root, "source"); await fs.mkdir(source);
  execFileSync("git", ["init", "-q", source]); execFileSync("git", ["-C", source, "config", "user.email", "porta@example.invalid"]); execFileSync("git", ["-C", source, "config", "user.name", "Porta Web Test"]);
  await fs.writeFile(join(source, "README.txt"), "clone baseline\n"); execFileSync("git", ["-C", source, "add", "--", "README.txt"]); execFileSync("git", ["-C", source, "commit", "-qm", "baseline"]);
  const dataDirectory = join(root, "server-data"); const emptyBase = join(root, "empty-base"); await fs.mkdir(emptyBase);
  const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "fixture" }, filesystem: { root: emptyBase, mutation: { enabled: true } }, git: { enabled: true }, authorization: { mode: "require-approval" } });
  const application = await createPortaApplication(config, { dataDirectory, skipModelHealth: true, model: () => new ScriptedToolModelProvider([]) });
  const web = createPortaWebServer({ ...application, uiSessions: new Map([["browser", Date.now() + 60000]]) }, { port: 0 }); await web.listen();
  const address = web.server.address(); if (!address || typeof address === "string") throw new Error("web server did not bind");
  const base = `http://127.0.0.1:${address.port}`; const headers = { cookie: "porta_ui=browser", "content-type": "application/json" };
  const postSession = (body: unknown) => fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    expect((await fetch(`${base}/api/projects`)).status).toBe(401);
    const unsafeUrl = await postSession({ repository: "https://user:secret@example.invalid/private.git" });
    expect(unsafeUrl.status).toBe(400); expect(JSON.stringify(await unsafeUrl.json())).not.toContain("secret");

    const globalCredentialResponse = await fetch(`${base}/api/git-credentials`, { method: "POST", headers, body: JSON.stringify({ name: "Team token", type: "https", username: "porta", password: "global-token-secret" }) });
    expect(globalCredentialResponse.status).toBe(201); const globalCredentialBody = await globalCredentialResponse.json() as { credential: { id: string } };
    expect(JSON.stringify(globalCredentialBody)).not.toContain("global-token-secret");
    const privateKey = "PRIVATE_KEY_API_SECRET"; const knownHosts = "KNOWN_HOSTS_API_SECRET";
    const sshCredentialResponse = await fetch(`${base}/api/git-credentials`, { method: "POST", headers, body: JSON.stringify({ name: "homelab-nas", type: "ssh", privateKey, knownHosts, sshConfig: "User eugen" }) });
    expect(sshCredentialResponse.status).toBe(201); const sshCredentialBody = await sshCredentialResponse.json() as { credential: { id: string; name: string; type: string } };
    expect(sshCredentialBody.credential).toMatchObject({ name: "homelab-nas", type: "ssh" });
    expect(JSON.stringify(sshCredentialBody)).not.toContain(privateKey); expect(JSON.stringify(sshCredentialBody)).not.toContain(knownHosts);
    const createdResponse = await postSession({ repository: `file://${source}`, credentialIds: [globalCredentialBody.credential.id, sshCredentialBody.credential.id], gitCredential: { name: "Session token", type: "https", username: "porta", password: "session-token-secret" } });
    expect(createdResponse.status).toBe(200); const created = await createdResponse.json() as { sessionId: string; workspace: { workspaceId: string; name: string } };
    expect(JSON.stringify(created)).not.toContain("secret"); expect(JSON.stringify(created)).not.toContain("token");
    const originalPath = await application.workspaces.workspaceForSession(created.sessionId);
    expect(await fs.readFile(join(originalPath, "README.txt"), "utf8")).toBe("clone baseline\n");
    expect(application.toolRouter.descriptorFor("git/status")).toBeDefined();
    const gitStatus = await application.toolRouter.invoke({ schemaVersion: 1, requestId: "session-git-status", toolId: "git/status", input: {} }, { traceId: "session-workspace-test", sessionId: created.sessionId, executionId: "session-workspace-test", signal: new AbortController().signal });
    expect(gitStatus).toMatchObject({ ok: true, output: { clean: true } });
    await fs.writeFile(join(originalPath, "work.txt"), "keep me\n");
    expect(await fs.readFile(join(source, "README.txt"), "utf8")).toBe("clone baseline\n");
    const scopedCredentials = await fetch(`${base}/api/git-credentials?sessionId=${encodeURIComponent(created.sessionId)}`, { headers });
    const listedCredentials = await scopedCredentials.json(); expect(JSON.stringify(listedCredentials)).not.toContain("secret"); expect(JSON.stringify(listedCredentials)).not.toContain(privateKey); expect(JSON.stringify(listedCredentials)).not.toContain(knownHosts); expect(listedCredentials.credentials).toHaveLength(3);

    const inUseDelete = await fetch(`${base}/api/git-credentials/${sshCredentialBody.credential.id}`, { method: "DELETE", headers });
    expect(inUseDelete.status).toBe(409); expect(JSON.stringify(await inUseDelete.json())).not.toContain(privateKey);
    const missingChoice = await fetch(`${base}/api/sessions/${created.sessionId}`, { method: "DELETE", headers });
    expect(missingChoice.status).toBe(400);
    const keptResponse = await fetch(`${base}/api/sessions/${created.sessionId}`, { method: "DELETE", headers, body: JSON.stringify({ disposition: "keep" }) });
    expect(keptResponse.status).toBe(200); const kept = await keptResponse.json() as { savedProjectId: string }; expect(kept.savedProjectId).toBe(created.workspace.workspaceId);
    expect((await fetch(`${base}/api/git-credentials?sessionId=${encodeURIComponent(created.sessionId)}`, { headers }).then((value) => value.json())).credentials).toHaveLength(2);
    expect((await fetch(`${base}/api/projects`, { headers }).then((value) => value.json())).projects).toHaveLength(1);

    const reopenedResponse = await postSession({ savedProjectId: kept.savedProjectId, credentialIds: [globalCredentialBody.credential.id] });
    expect(reopenedResponse.status).toBe(200); const reopened = await reopenedResponse.json() as { sessionId: string; workspace: { workspaceId: string } };
    expect(reopened.workspace.workspaceId).toBe(kept.savedProjectId); expect(await application.workspaces.workspaceForSession(reopened.sessionId)).toBe(originalPath);
    expect(await fs.readFile(join(originalPath, "work.txt"), "utf8")).toBe("keep me\n");
    const deleted = await fetch(`${base}/api/sessions/${reopened.sessionId}`, { method: "DELETE", headers, body: JSON.stringify({ disposition: "delete" }) });
    expect(deleted.status).toBe(200); await expect(fs.stat(originalPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fetch(`${base}/api/projects`, { headers }).then((value) => value.json())).projects).toEqual([]);
    const deletedCredential = await fetch(`${base}/api/git-credentials/${sshCredentialBody.credential.id}`, { method: "DELETE", headers });
    expect(deletedCredential.status).toBe(200);
  } finally { await web.close(); await application.shutdown(); }
});
