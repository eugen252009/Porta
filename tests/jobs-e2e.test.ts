import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelContext, ModelRequest } from "../src/contracts.js";
import { ScriptedToolModelProvider } from "../src/agent-mocks.js";
import { parsePortaConfig } from "../src/porta-config.js";
import { createPortaNode } from "../src/porta-node.js";
import { createPortaWebServer } from "../src/web-server.js";
import { HostProcessSandbox } from "../src/adapters/sandbox-host-process.js";
import { IntegrationCredentialStore } from "../src/integration-auth.js";

async function wait(check: () => boolean) { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error("Timed out waiting for persisted job"); }

describe("browser-independent coding handoff", () => {
  it("keeps unlisted tools approval-gated and preserves the denial", async () => {
    const root = await mkdtemp(join(tmpdir(), "porta-job-scope-"));
    const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "fixture" }, filesystem: { root, mutation: { enabled: true } }, persistence: { enabled: true, path: join(root, "state.db") }, jobs: { unattendedTools: ["filesystem/read_file"] } });
    const model = new ScriptedToolModelProvider([[{ type: "tool", toolId: "filesystem/write_file", input: { path: "denied.txt", content: "no", mode: "create" } }], [{ type: "text", text: "The requested mutation was denied." }]]);
    const node = await createPortaNode(config, { identityDirectory: join(root, "identity"), factories: { model: () => model } });
    try {
      await node.application.start();
      const receipt = await node.application.promptSubmission.submit({ content: "Attempt a write", idempotencyKey: "scope" }, { kind: "human", identity: "test" });
      await wait(() => node.application.promptSubmission.jobs.store.get(receipt.jobId!)?.status === "needs_attention");
      const approval = node.application.pendingApprovals.pendingRequests()[0]!;
      node.application.pendingApprovals.resolve(approval.approvalId, { decision: "deny", reason: "Outside the authorized scope" });
      await wait(() => node.application.promptSubmission.jobs.store.get(receipt.jobId!)?.status === "completed");
      await expect(readFile(join(root, "denied.txt"))).rejects.toThrow();
      expect(JSON.stringify(node.application.promptSubmission.jobs.store.get(receipt.jobId!)?.activity)).toContain("Approval denied");
      await expect(node.application.promptSubmission.submit({ content: "no permission", idempotencyKey: "denied" }, { kind: "integration", identity: "untrusted", permissions: [] })).rejects.toMatchObject({ kind: "denied" });
    } finally { await node.close(); await rm(root, { recursive: true, force: true }); }
  });
  it("accepts through the extension API, writes and tests without observers, and restores the result", async () => {
    const root = await mkdtemp(join(tmpdir(), "porta-job-e2e-")); const workspace = join(root, "workspace"); await mkdir(workspace);
    const auth = new IntegrationCredentialStore(join(root, "auth")); const credential = auth.create("extension", ["prompt.submit"]);
    const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "fixture" }, filesystem: { root: workspace, mutation: { enabled: true } }, execution: { enabled: true, allowedCommands: ["node"], filesystem: "allow", network: "allow", codeLoading: "allow" }, persistence: { enabled: true, path: join(root, "state.db") }, jobs: { unattendedTools: ["filesystem/write_file", "execution/run"] } });
    let releaseModel!: () => void; const browserClosed = new Promise<void>((resolve) => { releaseModel = resolve; });
    class BrowserIndependentModel extends ScriptedToolModelProvider {
      override async *generate(request: ModelRequest, context: ModelContext) { await browserClosed; yield* super.generate(request, context); }
    }
    const model = new BrowserIndependentModel([
      [{ type: "tool", toolId: "filesystem/write_file", input: { path: "check.cjs", content: "require('node:assert').equal(2 + 2, 4); console.log('CHECK_PASSED');", mode: "create" } }],
      [{ type: "tool", toolId: "execution/run", input: { command: "node", args: ["check.cjs"] } }],
      [{ type: "text", text: "Created check.cjs and executed node check.cjs. CHECK_PASSED." }],
    ]);
    const factories = { dataDirectory: join(root, "porta-data"), model: () => model, integrationAuth: auth, executionSandbox: new HostProcessSandbox() };
    let node = await createPortaNode(config, { identityDirectory: join(root, "identity"), factories });
    let web = createPortaWebServer({ ...node.application, uiSessions: new Map([["test", Date.now() + 60000]]) }, { port: 0 });
    try {
      await node.application.start(); await web.listen(); const address = web.server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/prompt/submit`, { method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" }, body: JSON.stringify({ content: "Create and test a local JavaScript fixture.", idempotencyKey: "handoff", source: "chatgpt-browser-extension" }) });
      expect(response.status).toBe(202); const receipt = await response.json() as { sessionId: string; jobId: string; durable: boolean }; expect(receipt.durable).toBe(true);
      // No page, SSE subscription, or browser-side execution loop exists after this point.
      await web.close();
      expect(model.turns).toBe(0); releaseModel();
      await wait(() => node.application.promptSubmission.jobs.store.get(receipt.jobId)?.status === "completed");
      const sessionWorkspace = await node.application.workspaces.workspaceForSession(receipt.sessionId);
      expect(await readFile(join(sessionWorkspace, "check.cjs"), "utf8")).toContain("CHECK_PASSED");
      expect(node.application.pendingApprovals.pendingCount).toBe(0);
      const toolMessages = model.received.flatMap((request) => request.messages ?? []).filter((message) => message.role === "tool");
      expect(JSON.stringify(toolMessages)).toContain("CHECK_PASSED");
      expect(JSON.stringify(toolMessages)).toContain('"exitCode":0');
      await node.close();
      node = await createPortaNode(config, { identityDirectory: join(root, "identity"), factories }); await node.application.start();
      web = createPortaWebServer({ ...node.application, uiSessions: new Map([["test", Date.now() + 60000]]) }, { port: 0 }); await web.listen();
      const nextAddress = web.server.address(); if (!nextAddress || typeof nextAddress === "string") throw new Error("Missing address");
      const snapshot = await fetch(`http://127.0.0.1:${nextAddress.port}/api/sessions/${receipt.sessionId}`, { headers: { cookie: "porta_ui=test" } });
      expect(await snapshot.json()).toMatchObject({ status: "completed", job: { id: receipt.jobId, status: "completed" } });
      const retry = await node.application.promptSubmission.submit({ content: "retry", idempotencyKey: "handoff" }, auth.authenticate(credential.token)!);
      expect(retry.jobId).toBe(receipt.jobId); expect(model.turns).toBe(3);
    } finally { releaseModel(); await web.close().catch(() => undefined); await node.close(); await rm(root, { recursive: true, force: true }); }
  });
});
