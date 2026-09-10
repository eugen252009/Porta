import { mkdtempSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPortaNode, type PortaNode } from "../src/porta-node.js";
import { NodeDelegationClient } from "../src/node-delegation.js";
import { HttpTargetTransport } from "../src/target-transport.js";
import { parsePortaConfig } from "../src/porta-config.js";
import type { ModelEvent, ModelProvider, ModelRequest, ModelContext } from "../src/contracts.js";

class LocalExecutionModel implements ModelProvider {
  readonly descriptor = { id: "local-script", version: "1", capabilities: [] };
  async *generate(request: ModelRequest, _context: ModelContext): AsyncIterable<ModelEvent> {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (request.messages?.some((message) => message.role === "tool")) {
      yield { type: "delta", text: "Node version inspected locally." };
      yield { type: "completed" };
      return;
    }
    yield { type: "tool-call", call: { id: "local-call", toolId: "execution/run", input: { command: "node", args: ["--version"] } } };
    yield { type: "completed" };
  }
}

async function fixture(authorizationMode: "allow-all" | "require-approval" = "allow-all") {
  const root = mkdtempSync(join(tmpdir(), "porta-delegation-node-"));
  const workspace = join(root, "child-workspace"); mkdirSync(workspace);
  const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "unused" }, authorization: { mode: authorizationMode } });
  const parent = await createPortaNode(config, { identityDirectory: join(root, "parent-identity"), factories: { model: () => new LocalExecutionModel() } });
  const child = await createPortaNode(config, { target: { id: "child", workspaceId: "child-workspace", workspaceRoot: workspace, identityDirectory: join(root, "child-identity"), allowedClientIdentities: [parent.identity.public] }, factories: { model: () => new LocalExecutionModel() } });
  await parent.application.start(); await child.application.start();
  const address = await child.targetServer!.listen("127.0.0.1", 0);
  const transport = new HttpTargetTransport({ endpoint: `http://127.0.0.1:${address.port}`, clientIdentity: parent.identity });
  const client = new NodeDelegationClient(parent.application, transport, "child", parent.identity.public.identity);
  return { root, parent, child, client };
}

async function closeFixture(value: Awaited<ReturnType<typeof fixture>>): Promise<void> { await value.parent.close(); await value.child.close(); await rm(value.root, { recursive: true, force: true }); }

const request = (delegationId: string, objective = "Inspect the current Node.js version and report it.") => ({ version: 1 as const, type: "porta-delegated-task" as const, delegationId, objective });

describe("durable Porta node delegation", () => {
  it("accepts, persists, executes locally on the child, and projects the result", async () => {
    const value = await fixture();
    try {
      const started = Date.now(); const accepted = await value.client.create(request("delegation-1"));
      expect(Date.now() - started).toBeLessThan(1000);
      expect(accepted.childNodeId).toBe(value.child.identity.public.identity);
      expect(value.child.application.delegations.get(accepted.childTaskId)).toMatchObject({ authority: "child", status: expect.any(String), parentIdentity: value.parent.identity.public.identity });
      let state = await value.client.get(accepted);
      for (let attempt = 0; attempt < 30 && state.state !== "completed"; attempt++) { await new Promise((resolve) => setTimeout(resolve, 20)); state = await value.client.get(accepted); }
      expect(state.state).toBe("completed");
      expect(state.resultSummary).toContain("Node version inspected locally");
      expect(value.parent.application.delegations.get(accepted.delegationId)).toMatchObject({ authority: "parent-projection", status: "completed", version: state.taskVersion });
    } finally { await closeFixture(value); }
  });

  it("is idempotent and rejects conflicting duplicate delivery", async () => {
    const value = await fixture();
    try {
      const first = await value.client.create(request("delegation-duplicate"));
      const second = await value.client.create(request("delegation-duplicate"));
      expect(second.childTaskId).toBe(first.childTaskId);
      await expect(value.client.create(request("delegation-duplicate", "different objective"))).rejects.toThrow();
      expect(value.child.application.delegations.findByDelegation("delegation-duplicate", value.parent.identity.public.identity)?.id).toBe(first.childTaskId);
    } finally { await closeFixture(value); }
  });

  it("cancels only the authorized delegated child task", async () => {
    const value = await fixture();
    try {
      const accepted = await value.client.create(request("delegation-cancel"));
      const cancelled = await value.client.cancel(accepted);
      expect(cancelled.state).toBe("cancelled");
      expect(value.child.application.delegations.get(accepted.childTaskId)?.status).toBe("cancelled");
    } finally { await closeFixture(value); }
  });

  it("keeps the child locally usable when the parent is unavailable", async () => {
    const value = await fixture();
    try {
      await value.parent.close();
      const events = [];
      for await (const event of value.child.application.gateway.execute({ type: "CreateSession", target: "local" })) events.push(event);
      expect(events).toContainEqual(expect.objectContaining({ type: "SessionCreated" }));
    } finally { await value.child.close(); await rm(value.root, { recursive: true, force: true }); }
  });

  it("keeps child-local approval policy authoritative", async () => {
    const value = await fixture("require-approval");
    try {
      const accepted = await value.client.create(request("delegation-policy"));
      for (let attempt = 0; attempt < 20 && value.child.application.pendingApprovals.pendingCount === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(value.child.application.pendingApprovals.pendingCount).toBeGreaterThan(0);
      for (const approval of value.child.application.pendingApprovals.pendingRequests()) value.child.application.pendingApprovals.resolve(approval.approvalId, { decision: "approve" });
      let state = await value.client.get(accepted);
      for (let attempt = 0; attempt < 20 && state.state !== "completed"; attempt++) { await new Promise((resolve) => setTimeout(resolve, 20)); state = await value.client.get(accepted); }
      expect(state.state).toBe("completed");
    } finally { await closeFixture(value); }
  });

  it("keeps the parent projection last-known when the child becomes unavailable", async () => {
    const value = await fixture();
    const accepted = await value.client.create(request("delegation-unavailable"));
    await value.child.close();
    try { await value.client.get(accepted); } catch {}
    expect(value.parent.application.delegations.get(accepted.delegationId)).toMatchObject({ authority: "parent-projection", status: expect.any(String), stale: true });
    await value.parent.close(); await rm(value.root, { recursive: true, force: true });
  });
});
