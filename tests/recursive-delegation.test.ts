import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ModelContext } from "../src/contracts.js";
import { InstanceIdentityStore } from "../src/identity.js";
import { createPortaNode } from "../src/porta-node.js";
import { parsePortaConfig } from "../src/porta-config.js";
import { HttpTargetTransport } from "../src/target-transport.js";
import { RemoteApplicationGateway } from "../src/remote-application.js";
import { NodeDelegationClient } from "../src/node-delegation.js";
import { RemoteExecutionTarget, TargetRegistry } from "../src/target.js";

class RecursiveQualificationModel implements ModelProvider {
  readonly descriptor = { id: "recursive-qualification", version: "1", capabilities: [{ id: "model.streaming", version: "1" }] };
  async *generate(request: ModelRequest, _context: ModelContext): AsyncIterable<ModelEvent> {
    const hasToolResult = request.messages?.some((message) => message.role === "tool");
    const delegate = request.tools?.find((tool) => tool.name === "agent/delegate" || tool.id === "delegate" || tool.id.includes("delegate"));
    const execute = request.tools?.find((tool) => tool.name === "execution/run" || tool.id === "run" || tool.id.includes("execution"));
    if (!hasToolResult && delegate && request.input.toLowerCase().includes("delegate")) { yield { type: "tool-call", call: { id: "delegate-once", toolId: delegate.name ?? delegate.id, input: { targetNodeId: "c", objective: "Obtain the Node.js version from C and return it." } } }; return; }
    if (!hasToolResult && execute) { yield { type: "tool-call", call: { id: "execute-once", toolId: execute.name ?? execute.id, input: { command: "node --version" } } }; return; }
    yield { type: "delta", text: request.input.includes("Node.js version") ? "C node version obtained." : "B received the child result." };
    yield { type: "completed" };
  }
}

async function threeNodes() {
  const root = mkdtempSync(join(tmpdir(), "porta-recursive-")); const workspaces: [string, string, string] = ["a", "b", "c"].map((name) => { const path = join(root, `workspace-${name}`); mkdirSync(path); return path; }) as [string, string, string];
  const identities: [InstanceIdentityStore, InstanceIdentityStore, InstanceIdentityStore] = ["a", "b", "c"].map((name) => new InstanceIdentityStore(join(root, `identity-${name}`))) as [InstanceIdentityStore, InstanceIdentityStore, InstanceIdentityStore];
  const config = () => parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "recursive-qualification" }, authorization: { mode: "allow-all" }, delegation: { enabled: true, maxDepth: 2, maxChildren: 4 } });
  const c = await createPortaNode(config(), { identity: identities[2], factories: { model: () => new RecursiveQualificationModel() }, target: { id: "c", workspaceId: "workspace-c", workspaceRoot: workspaces[2], identityDirectory: join(root, "identity-c"), allowedClientIdentities: [identities[1].public], allowedCommands: ["node"] } });
  const cAddress = await c.targetServer!.listen();
  const cTransport = new HttpTargetTransport({ endpoint: `http://127.0.0.1:${cAddress.port}`, clientIdentity: identities[1] });
  const cTarget = new RemoteExecutionTarget("c", "porta-node", cTransport, "workspace-c"); const bTargets = new TargetRegistry(); bTargets.register(cTarget);
  const b = await createPortaNode(config(), { identity: identities[1], factories: { model: () => new RecursiveQualificationModel(), targetRegistry: bTargets }, target: { id: "b", workspaceId: "workspace-b", workspaceRoot: workspaces[1], identityDirectory: join(root, "identity-b"), allowedClientIdentities: [identities[0].public], allowedCommands: ["node"] } });
  const bAddress = await b.targetServer!.listen(); const bTransport = new HttpTargetTransport({ endpoint: `http://127.0.0.1:${bAddress.port}`, clientIdentity: identities[0] });
  const aTargets = new TargetRegistry(); aTargets.register(new RemoteExecutionTarget("b", "porta-node", bTransport, "workspace-b"));
  const a = await createPortaNode(config(), { identity: identities[0], factories: { model: () => new RecursiveQualificationModel(), targetRegistry: aTargets } }); await a.application.start(); await b.application.start(); await c.application.start();
  return { root, a, b, c, bTransport, cEndpoint: `http://127.0.0.1:${cAddress.port}` };
}

describe("safe recursive delegation", () => {
  it("executes A → B → C with child-owned state and result propagation", async () => {
    const value = await threeNodes(); const remote = new RemoteApplicationGateway(value.bTransport); const client = new NodeDelegationClient(value.a.application, remote, "b");
    try {
      const accepted = await client.create({ version: 1, type: "porta-delegated-task", delegationId: "recursive-ab", objective: "Delegate to C to obtain the Node.js version.", permissions: ["filesystem.write"] });
      for (let attempt = 0; attempt < 50; attempt++) { const snapshot = await client.get(accepted); if (["completed", "failed", "cancelled"].includes(snapshot.state)) break; await new Promise((resolve) => setTimeout(resolve, 20)); }
      const parent = value.a.application.delegations.get(accepted.delegationId); const child = value.b.application.delegations.list().find((task) => task.parentNodeId === value.a.identity.public.identity); const grandchild = value.b.application.delegations.list().find((task) => task.authority === "parent-projection");
      expect(parent?.status).toBe("completed"); expect(child?.authority).toBe("child"); expect(grandchild?.authority).toBe("parent-projection"); expect(grandchild?.context?.originNodeId).toBe(value.a.identity.public.identity); const cTask = grandchild?.childTaskId ? value.c.application.delegations.get(grandchild.childTaskId) : undefined; expect(cTask?.effectivePermissions).not.toContain("filesystem.write");
    } finally { await value.a.close(); await value.b.close(); await value.c.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("continues detached nested execution after the parent disconnects", async () => {
    const value = await threeNodes(); const client = new NodeDelegationClient(value.a.application, new RemoteApplicationGateway(value.bTransport), "b");
    try {
      const accepted = await client.create({ version: 1, type: "porta-delegated-task", delegationId: "detached-recursive", objective: "Delegate to C to obtain the Node.js version." }); await value.a.close();
      for (let attempt = 0; attempt < 50; attempt++) { const task = value.b.application.delegations.findByDelegation(accepted.delegationId, value.a.identity.public.identity); if (task?.status === "completed") break; await new Promise((resolve) => setTimeout(resolve, 20)); }
      expect(value.b.application.delegations.findByDelegation(accepted.delegationId, value.a.identity.public.identity)?.status).toBe("completed");
    } finally { await value.b.close(); await value.c.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("keeps trust edge-local: B can reach C but A cannot impersonate B", async () => {
    const value = await threeNodes();
    try {
      const direct = new RemoteApplicationGateway(new HttpTargetTransport({ endpoint: value.cEndpoint, clientIdentity: value.a.identity }));
      await expect(direct.describe()).rejects.toMatchObject({ kind: "denied" });
      expect((await new RemoteApplicationGateway(new HttpTargetTransport({ endpoint: value.cEndpoint, clientIdentity: value.b.identity })).describe()).nodeIdentity).toBe(value.c.identity.public.identity);
    } finally { await value.a.close(); await value.b.close(); await value.c.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("rejects loops and exhausted depth before creating another child", async () => {
    const value = await threeNodes();
    try {
      const target = value.b.application.executionTargets.resolve("c"); expect(target?.application).toBeDefined();
      const base = value.b.application.delegations.list()[0] ?? { id: "synthetic", objective: "synthetic", effectivePermissions: ["agent.delegate"], context: { originNodeId: value.a.identity.public.identity, parentNodeId: value.a.identity.public.identity, currentNodeId: value.b.identity.public.identity, traceId: "trace", delegationDepth: 1, maxDelegationDepth: 2, visitedNodeIds: [value.a.identity.public.identity, value.b.identity.public.identity] } } as never;
      const loop = await value.b.application.delegatedTasks.delegateChild({ ...base, context: { ...base.context!, visitedNodeIds: [...base.context!.visitedNodeIds, (await target!.application!.describe()).nodeIdentity] } }, "c", { objective: "loop" });
      expect(loop.ok).toBe(false); if (!loop.ok) expect(loop.error?.code).toBe("AUTHORIZATION_DENIED");
      const depth = await value.b.application.delegatedTasks.delegateChild({ ...base, context: { ...base.context!, delegationDepth: 2 } }, "c", { objective: "too deep" });
      expect(depth.ok).toBe(false); if (!depth.ok) expect(depth.error?.code).toBe("AUTHORIZATION_DENIED");
      const unknown = await value.b.application.delegatedTasks.delegateChild(base, "unknown", { objective: "no fallback" });
      expect(unknown.ok).toBe(false); if (!unknown.ok) expect(unknown.error?.code).toBe("CAPABILITY_UNAVAILABLE");
    } finally { await value.a.close(); await value.b.close(); await value.c.close(); await rm(value.root, { recursive: true, force: true }); }
  });
});
