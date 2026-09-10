import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockModelProvider } from "../src/adapters.js";
import { createPortaNode } from "../src/porta-node.js";
import { InstanceIdentityStore } from "../src/identity.js";
import { HttpTargetTransport } from "../src/target-transport.js";
import { parsePortaConfig } from "../src/porta-config.js";

async function nodeFixture() {
  const root = mkdtempSync(join(tmpdir(), "porta-node-"));
  await mkdir(join(root, "workspace"));
  writeFileSync(join(root, "workspace", "hello.txt"), "node-local\n");
  const clientDirectory = join(root, "client");
  const client = new InstanceIdentityStore(clientDirectory);
  const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "test" }, authorization: { mode: "allow-all" } });
  const node = await createPortaNode(config, {
    target: { id: "node-a", workspaceId: "workspace-a", workspaceRoot: join(root, "workspace"), identityDirectory: join(root, "node-identity"), allowedClientIdentities: [client.public] },
    factories: { model: () => new MockModelProvider("local node") },
  });
  await node.application.start();
  const address = await node.targetServer!.listen("127.0.0.1", 0);
  const transport = new HttpTargetTransport({ endpoint: `http://127.0.0.1:${address.port}`, clientIdentity: client });
  return { root, node, transport };
}

describe("unified Porta node phase 1", () => {
  it("keeps the full application and authenticated target protocol in one process", async () => {
    const fixture = await nodeFixture();
    try {
      const events = [];
      for await (const event of fixture.node.application.gateway.execute({ type: "CreateSession", target: "local" })) events.push(event);
      expect(events).toContainEqual(expect.objectContaining({ type: "SessionCreated" }));
      const description = await fixture.transport.describe();
      expect(description).toMatchObject({ id: "node-a", workspace: { id: "workspace-a" } });
      const result = await fixture.transport.invoke({ requestId: "phase1-execution", targetId: "node-a", workspaceId: "workspace-a", operation: "execution.run", input: { command: "node", args: ["--version"] } });
      expect(result.status).toBe("completed");
      expect((result.output as { cwd: string }).cwd).toBe(join(fixture.root, "workspace"));
      const afterRemoteInvocation = [];
      for await (const event of fixture.node.application.gateway.execute({ type: "CreateSession", target: "local" })) afterRemoteInvocation.push(event);
      expect(afterRemoteInvocation).toContainEqual(expect.objectContaining({ type: "SessionCreated" }));
      expect(fixture.node.application.executionTargets.list()).toEqual([]);
    } finally { await fixture.node.close(); await rm(fixture.root, { recursive: true, force: true }); }
  });

  it("preserves local workspace confinement and permits child relationships structurally", async () => {
    const fixture = await nodeFixture();
    try {
      const outside = await fixture.transport.invoke({ requestId: "phase1-confinement", targetId: "node-a", workspaceId: "workspace-a", operation: "filesystem.read", input: { path: "../outside.txt" } });
      expect(outside.status).toBe("failed");
      const child = { id: "child", kind: "remote", workspace: { id: "child-workspace", path: "/child" }, capabilities: async () => ["execution.run"] as const, available: async () => true };
      fixture.node.application.executionTargets.register(child);
      expect(fixture.node.application.executionTargets.resolve("child")).toBe(child);
    } finally { await fixture.node.close(); await rm(fixture.root, { recursive: true, force: true }); }
  });
});
