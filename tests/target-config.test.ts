import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockModelProvider } from "../src/adapters.js";
import { createPortaApplication } from "../src/porta-application.js";
import { parsePortaConfig } from "../src/porta-config.js";
import { InstanceIdentityStore } from "../src/identity.js";
import { createTargetTransportServer, InMemoryTargetTransport } from "../src/target-transport.js";

const description = { id: "pc-main", kind: "development-pc", available: true, capabilities: ["filesystem.read", "execution.run"] as const, workspace: { id: "porta-main", path: "/workspace" }, platform: "linux" };

describe("persistent execution target composition", () => {
  it("constructs configured remote targets with the application identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "porta-target-config-")); const serverRoot = mkdtempSync(join(tmpdir(), "porta-target-config-server-")); const clientIdentity = new InstanceIdentityStore(root); const serverIdentity = new InstanceIdentityStore(serverRoot); serverIdentity.allow(clientIdentity.public, "orchestrator"); const server = createTargetTransportServer({ target: description, identity: serverIdentity, operations: new InMemoryTargetTransport(description, { "package.json": "remote" }), allowedIdentities: [] }); const address = await server.listen(); const previous = process.env.PORTA_DATA_DIR; process.env.PORTA_DATA_DIR = root;
    try { const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "test" }, executionTargets: [{ id: "pc-main", kind: "development-pc", transport: "http", endpoint: `http://${address.host}:${address.port}`, workspaceId: "porta-main" }] }); const app = await createPortaApplication(config, { model: () => new MockModelProvider("ready") }); const target = app.executionTargets.resolve("pc-main"); expect(target).toBeDefined(); expect(await target!.available()).toBe(true); expect(target!.workspace?.id).toBe("porta-main"); await app.shutdown(); } finally { if (previous === undefined) delete process.env.PORTA_DATA_DIR; else process.env.PORTA_DATA_DIR = previous; await server.close(); rmSync(root, { recursive: true, force: true }); rmSync(serverRoot, { recursive: true, force: true }); }
  });

  it("starts with an offline configured target and keeps web targets separate", async () => {
    const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "test" }, executionTargets: [{ id: "pc-main", endpoint: "http://127.0.0.1:1", workspaceId: "porta-main" }], web: { targets: [{ id: "ui-remote", name: "UI", endpoint: "http://127.0.0.1:2" }] } }); const app = await createPortaApplication(config, { model: () => new MockModelProvider("ready") });
    try { expect(app.executionTargets.resolve("pc-main")).toBeDefined(); expect(await app.executionTargets.resolve("pc-main")!.available()).toBe(false); expect(app.executionTargets.resolve("ui-remote")).toBeUndefined(); } finally { await app.shutdown(); }
  });
});
