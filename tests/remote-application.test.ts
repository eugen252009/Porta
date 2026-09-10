import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockModelProvider } from "../src/adapters.js";
import { createPortaNode } from "../src/porta-node.js";
import { parsePortaConfig } from "../src/porta-config.js";
import { HttpTargetTransport, targetRequest } from "../src/target-transport.js";
import { RemoteApplicationError, RemoteApplicationGateway } from "../src/remote-application.js";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "porta-remote-app-")); const workspace = join(root, "workspace"); mkdirSync(workspace);
  const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "unused" }, authorization: { mode: "allow-all" } });
  const a = await createPortaNode(config, { identityDirectory: join(root, "a"), factories: { model: () => new MockModelProvider("done") } });
  const b = await createPortaNode(config, { target: { id: "b", workspaceId: "b-workspace", workspaceRoot: workspace, identityDirectory: join(root, "b"), allowedClientIdentities: [a.identity.public] }, factories: { model: () => new MockModelProvider("done") } });
  await a.application.start(); await b.application.start(); const address = await b.targetServer!.listen("127.0.0.1", 0);
  const transport = new HttpTargetTransport({ endpoint: `http://127.0.0.1:${address.port}`, clientIdentity: a.identity });
  return { root, a, b, transport, endpoint: `http://127.0.0.1:${address.port}`, remote: new RemoteApplicationGateway(transport) };
}

describe("RemoteApplicationGateway", () => {
  it("supports delegated tasks, model discovery, and sessions through one remote abstraction", async () => {
    const value = await setup();
    try {
      const description = await value.remote.describe();
      expect(description.capabilities).toEqual(expect.arrayContaining(["delegatedTasks", "models", "sessions"]));
      expect((await value.remote.models()).every((model) => typeof model === "object")).toBe(true);
      const session = await value.remote.createSession({});
      expect((await value.remote.getSession(session.id))?.id).toBe(session.id);
      const accepted = await value.remote.createDelegatedTask({ version: 1, type: "porta-delegated-task", delegationId: "remote-1", objective: "remote operation" });
      expect((await value.remote.getDelegatedTask(accepted.childTaskId, accepted.delegationId)).childTaskId).toBe(accepted.childTaskId);
      expect(["cancelled", "completed"]).toContain((await value.remote.cancelDelegatedTask(accepted.childTaskId, accepted.delegationId)).state);
    } finally { await value.a.close(); await value.b.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("preserves one authenticated relationship for application and primitive compatibility calls", async () => {
    const value = await setup();
    try {
      const result = await value.transport.invoke(targetRequest("b", "b-workspace", "execution.run", { command: "not-available" }));
      expect(result.status).toBe("failed");
      expect((await value.remote.describe()).nodeIdentity).toBe(value.b.identity.public.identity);
    } finally { await value.a.close(); await value.b.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("distinguishes an unavailable remote node", async () => {
    const value = await setup(); await value.a.close(); await value.b.close();
    try { await expect(new RemoteApplicationGateway(new HttpTargetTransport({ endpoint: "http://127.0.0.1:1", clientIdentity: value.a.identity })).describe()).rejects.toMatchObject({ kind: "unavailable" }); }
    finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("does not allow an unrelated node to authenticate as an application client", async () => {
    const value = await setup(); const c = await createPortaNode(parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "unused" } }), { identityDirectory: join(value.root, "c"), factories: { model: () => new MockModelProvider("done") } });
    try { const remote = new RemoteApplicationGateway(new HttpTargetTransport({ endpoint: value.endpoint, clientIdentity: c.identity })); await expect(remote.describe()).rejects.toMatchObject({ kind: "denied" }); }
    finally { await c.close(); await value.a.close(); await value.b.close(); await rm(value.root, { recursive: true, force: true }); }
  });
});
