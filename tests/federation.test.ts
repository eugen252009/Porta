import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockModelProvider } from "../src/adapters.js";
import { InstanceIdentityStore } from "../src/identity.js";
import { createPortaNode } from "../src/porta-node.js";
import { parsePortaConfig } from "../src/porta-config.js";
import { HttpTargetTransport } from "../src/target-transport.js";
import { createNodeApplicationProtocol, RemoteApplicationGateway } from "../src/remote-application.js";
import { RemoteExecutionTarget, TargetRegistry } from "../src/target.js";
import { createPortaWebServer } from "../src/web-server.js";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "porta-federation-")); const aWorkspace = join(root, "a-workspace"); const bWorkspace = join(root, "b-workspace"); mkdirSync(aWorkspace); mkdirSync(bWorkspace);
  const identityA = new InstanceIdentityStore(join(root, "identity-a")); const identityB = new InstanceIdentityStore(join(root, "identity-b"));
  const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "local-model" }, authorization: { mode: "allow-all" }, delegation: { enabled: true } });
  const b = await createPortaNode(config, { identity: identityB, factories: { model: () => new MockModelProvider("B result") }, target: { id: "b", workspaceId: "b-workspace", workspaceRoot: bWorkspace, identityDirectory: join(root, "identity-b"), allowedClientIdentities: [identityA.public] } });
  const bAddress = await b.targetServer!.listen(); const transport = new HttpTargetTransport({ endpoint: `http://127.0.0.1:${bAddress.port}`, clientIdentity: identityA }); const registry = new TargetRegistry(); registry.register(new RemoteExecutionTarget("b", "porta-node", transport, "b-workspace"));
  const a = await createPortaNode(config, { identity: identityA, factories: { model: () => new MockModelProvider("A result"), targetRegistry: registry } }); await a.application.start(); await b.application.start();
  return { root, a, b, transport, remote: new RemoteApplicationGateway(transport) };
}

describe("federated Web control", () => {
  it("projects remote result history and preserves ownership across protocol restart", async () => {
    const value = await setup();
    try {
      const session = await value.remote.createSession({});
      await value.remote.submitSession(session.id, "Federated history prompt");
      const observed = await value.remote.getSession(session.id);
      expect(observed?.history).toEqual(expect.arrayContaining([{ role: "user", content: "Federated history prompt" }, { role: "assistant", content: "B result" }]));
      const restartedProtocol = createNodeApplicationProtocol(value.b.application);
      const afterRestart = await restartedProtocol.getSession(session.id, value.a.identity.public.identity);
      expect(afterRestart?.history).toEqual(observed?.history);
    } finally { await value.a.close(); await value.b.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("projects remote tasks, approvals, and cancellation through the application boundary", async () => {
    const value = await setup();
    try {
      const session = await value.remote.createSession({});
      await value.b.application.tasks.create(session.id, "remote operation task");
      expect((await value.remote.getTask(session.id))?.status).toBe("active");
      const approvalPromise = value.b.application.pendingApprovals.approve({ approvalId: "remote-approval", toolCallId: "remote-call", invocation: { schemaVersion: 1, requestId: "remote-request", toolId: "execution/run", input: { command: "npm test" } }, context: { traceId: "remote-trace", sessionId: session.id, executionId: "remote-execution", signal: new AbortController().signal } });
      expect((await value.remote.listApprovals()).map((approval) => approval.approvalId)).toContain("remote-approval");
      const resolved = await value.remote.resolveApproval("remote-approval", "deny", "denied by remote operator");
      expect(resolved.decision).toBe("deny");
      await expect(approvalPromise).resolves.toMatchObject({ approved: false, reason: "denied by remote operator" });
      expect((await value.remote.cancelSession(session.id)).status).toBe("cancelled");
      expect((await value.remote.getTask(session.id))?.status).toBe("cancelled");
      expect(await value.remote.listApprovals()).toEqual([]);
    } finally { await value.a.close(); await value.b.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("aggregates a known child through application APIs and keeps sessions child-owned", async () => {
    const value = await setup(); const web = createPortaWebServer({ ...value.a.application, uiSessions: new Map([["human", Date.now() + 60_000]]) }, { port: 0 }); await web.listen(); const address = web.server.address(); if (!address || typeof address === "string") throw new Error("web address unavailable");
    try {
      const session = await value.remote.createSession({});
      const nodes = await fetch(`http://127.0.0.1:${address.port}/api/nodes`, { headers: { cookie: "porta_ui=human" } }); const nodeBody = await nodes.json(); expect(nodeBody.nodes.find((node: { id: string }) => node.id === "b")).toMatchObject({ available: true, stale: false });
      const models = await fetch(`http://127.0.0.1:${address.port}/api/models?target=b`, { headers: { cookie: "porta_ui=human" } }); expect((await models.json()).models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "local-model" })]));
      const unsupported = await fetch(`http://127.0.0.1:${address.port}/api/sessions?target=b`, { method: "POST", headers: { cookie: "porta_ui=human", "content-type": "application/json" }, body: JSON.stringify({ model: { provider: "ollama", model: "not-on-b" } }) }); expect(unsupported.ok).toBe(false);
      const sessions = await fetch(`http://127.0.0.1:${address.port}/api/sessions?target=b`, { headers: { cookie: "porta_ui=human" } }); expect((await sessions.json()).sessions.some((entry: { id: string }) => entry.id === session.id)).toBe(true);
      expect((await value.b.application.conversations.getSession(session.id))?.id).toBe(session.id);
      const delegated = await value.remote.createDelegatedTask({ version: 1, type: "porta-delegated-task", delegationId: "federation-task", objective: "federated task" }); const taskView = await fetch(`http://127.0.0.1:${address.port}/api/delegated-tasks?target=b`, { headers: { cookie: "porta_ui=human" } }); expect((await taskView.json()).tasks.some((task: { delegationId: string }) => task.delegationId === delegated.delegationId)).toBe(true);
      const created = await fetch(`http://127.0.0.1:${address.port}/api/sessions?target=b`, { method: "POST", headers: { cookie: "porta_ui=human", "content-type": "application/json" }, body: JSON.stringify({}) }); expect(created.status).toBe(200); const createdBody = await created.json(); expect((await value.b.application.conversations.getSession(createdBody.sessionId))?.id).toBe(createdBody.sessionId);
    } finally { await web.close(); await value.a.close(); await value.b.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("retains last-known child state and marks it stale when the child disappears", async () => {
    const value = await setup(); const web = createPortaWebServer({ ...value.a.application, uiSessions: new Map([["human", Date.now() + 60_000]]) }, { port: 0 }); await web.listen(); const address = web.server.address(); if (!address || typeof address === "string") throw new Error("web address unavailable");
    try {
      const first = await fetch(`http://127.0.0.1:${address.port}/api/nodes`, { headers: { cookie: "porta_ui=human" } }); expect((await first.json()).nodes.find((node: { id: string }) => node.id === "b").available).toBe(true);
      await value.b.targetServer!.close(); await value.b.application.shutdown();
      const second = await fetch(`http://127.0.0.1:${address.port}/api/nodes`, { headers: { cookie: "porta_ui=human" } }); expect((await second.json()).nodes.find((node: { id: string }) => node.id === "b")).toMatchObject({ available: false, stale: true, nodeIdentity: value.b.identity.public.identity });
    } finally { await web.close(); await value.a.close(); await rm(value.root, { recursive: true, force: true }); }
  });
});
