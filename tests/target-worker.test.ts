import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceIdentityStore } from "../src/identity.js";
import { HttpTargetTransport } from "../src/target-transport.js";
import { RemoteExecutionTarget } from "../src/target.js";
import { startTargetWorker } from "../src/target-worker.js";

describe("target worker composition", () => {
  it("exposes existing filesystem and execution providers over HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "porta-worker-root-")); const clientDir = mkdtempSync(join(tmpdir(), "porta-worker-client-")); const serverDir = mkdtempSync(join(tmpdir(), "porta-worker-server-"));
    writeFileSync(join(root, "package.json"), "target workspace\n"); const client = new InstanceIdentityStore(clientDir); const worker = await startTargetWorker({ targetId: "pc-main", workspaceId: "porta-main", workspaceRoot: root, identityDirectory: serverDir, allowedClientIdentities: [client.public], allowedCommands: ["node"] });
    try {
      const target = new RemoteExecutionTarget("pc-main", "development-pc", new HttpTargetTransport({ endpoint: `http://${worker.address.host}:${worker.address.port}`, clientIdentity: client }));
      expect(await target.available()).toBe(true); expect((await target.invoke("filesystem.read", { path: "package.json" })).output).toMatchObject({ content: "target workspace\n" });
      expect((await target.invoke("filesystem.write", { path: ".porta-target-qualification.txt", content: "ok", mode: "create" })).status).toBe("completed");
      expect((await target.invoke("execution.run", { command: "node", args: ["--version"] })).status).toBe("completed");
    } finally { await worker.close(); rmSync(root, { recursive: true, force: true }); rmSync(clientDir, { recursive: true, force: true }); rmSync(serverDir, { recursive: true, force: true }); }
  });
});
