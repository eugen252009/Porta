import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockModelProvider } from "../src/adapters.js";
import { createPortaNode } from "../src/porta-node.js";
import { NodeDelegationClient, type Principal } from "../src/node-delegation.js";
import { HttpTargetTransport } from "../src/target-transport.js";
import { parsePortaConfig } from "../src/porta-config.js";
import { createPortaWebServer } from "../src/web-server.js";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "porta-boundary-")); const workspace = join(root, "workspace"); mkdirSync(workspace);
  const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "unused" }, authorization: { mode: "allow-all" } });
  const parent = await createPortaNode(config, { identityDirectory: join(root, "parent") , factories: { model: () => new MockModelProvider("done") } });
  const child = await createPortaNode(config, { target: { id: "child", workspaceId: "workspace", workspaceRoot: workspace, identityDirectory: join(root, "child"), allowedClientIdentities: [parent.identity.public] }, factories: { model: () => new MockModelProvider("done") } });
  await parent.application.start(); await child.application.start(); const address = await child.targetServer!.listen("127.0.0.1", 0);
  const transport = new HttpTargetTransport({ endpoint: `http://127.0.0.1:${address.port}`, clientIdentity: parent.identity });
  const client = new NodeDelegationClient(parent.application, transport, "child");
  return { root, parent, child, client };
}

describe("Porta application boundary", () => {
  it("uses one delegated-task service for node and Web projections", async () => {
    const value = await setup(); const uiSessions = new Map([["human", Date.now() + 60_000]]); const web = createPortaWebServer({ ...value.child.application, uiSessions }, { port: 0 }); await web.listen(); const address = web.server.address(); if (!address || typeof address === "string") throw new Error("web address unavailable");
    try {
      const accepted = await value.client.create({ version: 1, type: "porta-delegated-task", delegationId: "boundary-1", objective: "observe" });
      const nodePrincipal: Principal = { kind: "node", identity: value.parent.identity.public.identity };
      const humanPrincipal: Principal = { kind: "human", identity: "web:human" };
      expect(value.child.application.delegatedTasks.getForPrincipal(accepted.childTaskId, nodePrincipal)?.id).toBe(accepted.childTaskId);
      expect(value.child.application.delegatedTasks.getForPrincipal(accepted.childTaskId, humanPrincipal)?.id).toBe(accepted.childTaskId);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/delegated-tasks`, { headers: { cookie: "porta_ui=human" } });
      expect((await response.json()).tasks.some((task: { id: string }) => task.id === accepted.childTaskId)).toBe(true);
    } finally { await web.close(); await value.parent.close(); await value.child.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("applies principal-specific access to the shared task semantics", async () => {
    const value = await setup();
    try {
      const accepted = await value.client.create({ version: 1, type: "porta-delegated-task", delegationId: "boundary-2", objective: "cancel" });
      const unrelated: Principal = { kind: "node", identity: "porta:ed25519:unrelated" };
      expect(value.child.application.delegatedTasks.list(unrelated)).toEqual([]);
      await expect(value.child.application.delegatedTasks.cancelForNode(accepted.childTaskId, accepted.delegationId, unrelated.identity)).rejects.toThrow();
      await value.child.application.delegatedTasks.cancelForPrincipal(accepted.childTaskId, { kind: "human", identity: "web:human" });
      expect(value.child.application.delegatedTasks.getForPrincipal(accepted.childTaskId, { kind: "human", identity: "web:human" })?.status).toBe("cancelled");
    } finally { await value.parent.close(); await value.child.close(); await rm(value.root, { recursive: true, force: true }); }
  });
});
