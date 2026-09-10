import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockModelProvider } from "../src/adapters.js";
import { InstanceIdentityStore } from "../src/identity.js";
import { IntegrationCredentialStore } from "../src/integration-auth.js";
import { createPortaNode } from "../src/porta-node.js";
import { parsePortaConfig } from "../src/porta-config.js";
import { HttpTargetTransport } from "../src/target-transport.js";
import { RemoteExecutionTarget, TargetRegistry } from "../src/target.js";
import { PromptSubmissionError } from "../src/prompt-submission.js";
import { createPortaWebServer } from "../src/web-server.js";

const principal = { kind: "integration" as const, identity: "integration:test", permissions: ["prompt.submit", "nodes.read", "models.read"] };
function config() { return parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "mock" }, authorization: { mode: "allow-all" } }); }

async function remoteFixture() {
  const root = mkdtempSync(join(tmpdir(), "porta-prompt-")); const aWorkspace = join(root, "a"); const bWorkspace = join(root, "b"); mkdirSync(aWorkspace); mkdirSync(bWorkspace); const identityA = new InstanceIdentityStore(join(root, "identity-a")); const identityB = new InstanceIdentityStore(join(root, "identity-b"));
  const b = await createPortaNode(config(), { identity: identityB, factories: { model: () => new MockModelProvider("remote") }, target: { id: "b", workspaceId: "b", workspaceRoot: bWorkspace, identityDirectory: join(root, "identity-b"), allowedClientIdentities: [identityA.public] } }); const address = await b.targetServer!.listen(); const transport = new HttpTargetTransport({ endpoint: `http://127.0.0.1:${address.port}`, clientIdentity: identityA }); const registry = new TargetRegistry(); registry.register(new RemoteExecutionTarget("b", "porta-node", transport, "b")); const a = await createPortaNode(config(), { identity: identityA, factories: { model: () => new MockModelProvider("local"), targetRegistry: registry } }); await a.application.start(); await b.application.start(); return { root, a, b, transport };
}

describe("prompt submission", () => {
  it("creates normal local work and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "porta-prompt-local-")); const auth = new IntegrationCredentialStore(join(root, "credentials")); const app = await createPortaNode(config(), { identityDirectory: join(root, "identity"), factories: { model: () => new MockModelProvider("local"), integrationAuth: auth } });
    try { let event; app.application.events.subscribe((value) => { event = value; }); const first = await app.application.promptSubmission.submit({ content: "# Qualification\nInspect Node.js.", idempotencyKey: "same", source: "external" }, principal); const second = await app.application.promptSubmission.submit({ content: "different retry body", idempotencyKey: "same", source: "external" }, principal); expect(second).toEqual(first); const continued = await app.application.promptSubmission.submit({ content: "follow-up", sessionId: first.sessionId, idempotencyKey: "follow-up", source: "external" }, principal); expect(continued.sessionId).toBe(first.sessionId); expect(event).toMatchObject({ type: "session.updated", nodeId: app.identity.public.identity, sessionId: first.sessionId }); expect(app.application.conversations.openSessionIds()).toEqual([first.sessionId]); } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("continues an existing remote session without creating a local or child duplicate", async () => {
    const value = await remoteFixture();
    try { const first = await value.a.application.promptSubmission.submit({ content: "Remote prompt A", targetNodeId: "b", idempotencyKey: "remote-a" }, principal); const second = await value.a.application.promptSubmission.submit({ content: "Remote prompt B", targetNodeId: "b", sessionId: first.sessionId, idempotencyKey: "remote-b" }, principal); expect(second.sessionId).toBe(first.sessionId); expect(value.a.application.conversations.openSessionIds()).toEqual([]); expect((await value.b.application.conversations.getSession(first.sessionId))?.id).toBe(first.sessionId); } finally { await value.a.close(); await value.b.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("rejects a missing or cross-target local session", async () => {
    const root = mkdtempSync(join(tmpdir(), "porta-prompt-session-validation-")); const app = await createPortaNode(config(), { identityDirectory: join(root, "identity"), factories: { model: () => new MockModelProvider("local") } });
    try { await expect(app.application.promptSubmission.submit({ content: "missing", sessionId: "missing", idempotencyKey: "missing" }, principal)).rejects.toMatchObject({ kind: "not_found" }); } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("routes direct remote work to the selected child without local duplication", async () => {
    const value = await remoteFixture();
    try { const result = await value.a.application.promptSubmission.submit({ content: "Remote prompt", targetNodeId: "b", idempotencyKey: "remote-1" }, principal); expect(result.nodeId).toBe("b"); expect(value.a.application.conversations.openSessionIds()).toEqual([]); expect((await value.b.application.conversations.getSession(result.sessionId))?.id).toBe(result.sessionId); } finally { await value.a.close(); await value.b.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("does not fall back when the selected child is unavailable", async () => {
    const value = await remoteFixture(); await value.b.targetServer!.close(); await value.b.application.shutdown();
    try { await expect(value.a.application.promptSubmission.submit({ content: "No fallback", targetNodeId: "b", idempotencyKey: "unavailable" }, principal)).rejects.toMatchObject({ kind: "unavailable" }); expect(value.a.application.conversations.openSessionIds()).toEqual([]); }
    finally { await value.a.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("authenticates scoped integration credentials and revokes them", async () => {
    const root = mkdtempSync(join(tmpdir(), "porta-prompt-auth-")); const auth = new IntegrationCredentialStore(join(root, "credentials")); const created = auth.create("chatgpt-extension", ["nodes.read", "models.read", "prompt.submit"]); expect(auth.authenticate(created.token)?.kind).toBe("integration"); auth.revoke(created.id); expect(auth.authenticate(created.token)).toBeUndefined(); expect(auth.allows(principal, "execution.run")).toBe(false); await rm(root, { recursive: true, force: true });
  });

  it("accepts the integration through the normal Web API", async () => {
    const root = mkdtempSync(join(tmpdir(), "porta-prompt-api-")); const auth = new IntegrationCredentialStore(join(root, "credentials")); const created = auth.create("test-extension", ["nodes.read", "models.read", "prompt.submit"]); const app = await createPortaNode(config(), { identityDirectory: join(root, "identity"), factories: { model: () => new MockModelProvider("api"), integrationAuth: auth } }); const web = createPortaWebServer({ ...app.application, uiSessions: new Map([["test", Date.now() + 60_000]]) }, { port: 0, extensionOrigins: ["chrome-extension://test"] }); await web.listen(); const address = web.server.address(); if (!address || typeof address === "string") throw new Error("web address unavailable");
    try { const stream = await fetch(`http://127.0.0.1:${address.port}/api/events`, { headers: { cookie: "porta_ui=test" } }); const reader = stream.body!.getReader(); await reader.read(); const response = await fetch(`http://127.0.0.1:${address.port}/api/prompt/submit`, { method: "POST", headers: { authorization: `Bearer ${created.token}`, origin: "chrome-extension://test", "content-type": "application/json" }, body: JSON.stringify({ content: "API prompt", targetNodeId: "local", idempotencyKey: "api-1" }) }); expect(response.status).toBe(202); expect(response.headers.get("access-control-allow-origin")).toBe("chrome-extension://test"); const accepted = await response.json() as { sessionId: string }; let eventText = ""; for (let attempt = 0; attempt < 10 && !eventText.includes("session.created"); attempt++) { const chunk = await reader.read(); if (chunk.done) break; eventText += new TextDecoder().decode(chunk.value); } expect(eventText).toContain("session.created"); const continued = await fetch(`http://127.0.0.1:${address.port}/api/prompt/submit`, { method: "POST", headers: { authorization: `Bearer ${created.token}`, origin: "chrome-extension://test", "content-type": "application/json" }, body: JSON.stringify({ content: "API follow-up", targetNodeId: "local", sessionId: accepted.sessionId, idempotencyKey: "api-2" }) }); expect(continued.status).toBe(202); expect((await continued.json()).sessionId).toBe(accepted.sessionId); await reader.cancel(); const forbidden = await fetch(`http://127.0.0.1:${address.port}/api/execution-invocations`, { method: "POST", headers: { authorization: `Bearer ${created.token}`, "content-type": "application/json" }, body: JSON.stringify({ targetId: "local", workspaceId: "local", operation: "execution.run" }) }); expect(forbidden.status).toBe(403); } finally { await web.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
