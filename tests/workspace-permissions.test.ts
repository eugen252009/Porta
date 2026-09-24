import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { WorkspaceFileAccess, WorkspaceToolAuthorizationPolicy } from "../src/workspace-permissions.js";
import { FilesystemToolProvider } from "../src/filesystem.js";
import type { JsonValue, KernelEvent, ToolAuthorizationRequest, ToolContext } from "../src/contracts.js";
import { ToolRouter } from "../src/tools.js";
import { InteractiveApprovalGateway } from "../src/application-gateway.js";
import { PendingApprovalProvider } from "../src/approval-pending.js";
import { ScriptedToolModelProvider } from "../src/agent-mocks.js";
import { AgentOrchestrator } from "../src/agent.js";
import { StaticApprovalProvider, StaticToolAuthorizationPolicy } from "../src/authorization-mocks.js";
import { MockToolProvider } from "../src/tool-mocks.js";
import { parsePortaConfig } from "../src/porta-config.js";
import { createPortaNode } from "../src/porta-node.js";

const context = (): ToolContext => ({ traceId: "test", sessionId: "test", executionId: "test", signal: new AbortController().signal });
const request = (toolId: string, input: JsonValue): ToolAuthorizationRequest => ({ toolCallId: "call", invocation: { schemaVersion: 1, requestId: "call", toolId, input }, context: context() });
async function collect(events: AsyncIterable<KernelEvent>) { const result: KernelEvent[] = []; for await (const event of events) result.push(event); return result; }

describe("workspace file permissions", () => {
  it("does not turn a recovered approval into blanket permission for subsequent tools", async () => {
    const router = new ToolRouter(); const tool = new MockToolProvider("provider"); await router.register("provider", tool, context());
    const approvals = new StaticApprovalProvider(false);
    const model = new ScriptedToolModelProvider([[{ type: "tool", id: "new-call", toolId: "provider/echo", input: { value: "unapproved" } }], [{ type: "text", text: "done" }]]);
    const now = new Date().toISOString();
    const execution = new AgentOrchestrator(model, router, undefined, { policy: new StaticToolAuthorizationPolicy("require-approval"), approvalProvider: approvals }).createRecovered({ executionId: "e", sessionId: "s", traceId: "t", phase: "tool_authorized", version: 1, input: "continue", history: [], currentToolCall: { id: "approved-call", toolId: "provider/echo", input: { value: "approved" } }, createdAt: now, updatedAt: now }, context(), router.listTools());
    for await (const _event of execution.events()) { /* drain */ }
    await execution.result();
    expect(tool.calls).toHaveLength(1); expect(approvals.requests).toHaveLength(1);
    expect(approvals.requests[0]?.toolCallId).toBe("new-call");
  });
  it("allows ordinary files but requires approval for sensitive names and every non-filesystem tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "porta-permissions-"));
    try {
      const files = new WorkspaceFileAccess(root, ["private/settings.txt"]); const policy = new WorkspaceToolAuthorizationPolicy(files);
      await mkdir(join(root, "src")); await mkdir(join(root, "private")); await writeFile(join(root, "src/main.ts"), "source");
      for (const tool of ["read_file", "write_file", "patch_file", "stat", "list_directory"]) expect(await policy.authorize(request(`filesystem/${tool}`, { path: "src/main.ts" }))).toBe("allow");
      for (const path of [".env", ".env.local", ".env.example", "key.pem", "private.key", "credentials.json", "state.db", "state.db-wal", "private/settings.txt"]) expect(await policy.authorize(request("filesystem/read_file", { path }))).toBe("require-approval");
      for (const tool of ["execution/run", "git/diff", "git/show", "custom/read"]) expect(await policy.authorize(request(tool, {}))).toBe("require-approval");
      for (const tool of ["scratchpad/read", "scratchpad/write", "task/get", "task/create", "artifact/read"]) expect(await policy.authorize(request(tool, {}))).toBe("allow");
      expect(await policy.authorize(request("filesystem/search", { query: "ordinary" }))).toBe("allow");
      for (const path of ["../outside", "/etc/passwd"]) expect(await policy.authorize(request("filesystem/read_file", { path }))).toBe("deny");
      expect(await policy.authorize(request("filesystem/read_file", []))).toBe("deny");
      const cancelled = request("filesystem/read_file", { path: "src/main.ts" }); const controller = new AbortController(); controller.abort();
      expect(await policy.authorize({ ...cancelled, context: { ...cancelled.context, signal: controller.signal } })).toBe("deny");
      expect(() => new WorkspaceFileAccess(root, ["../outside"])).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("filters secrets, credential directories, caches, symlinks and hardlinks before search or listing", async () => {
    const root = await mkdtemp(join(tmpdir(), "porta-protected-search-"));
    try {
      await writeFile(join(root, "ordinary.txt"), "needle ordinary"); await writeFile(join(root, ".env"), "needle SECRET_VALUE");
      for (const name of [".ssh", ".git", ".cocoindex_code"]) { await mkdir(join(root, name)); await writeFile(join(root, name, "cache"), "needle SECRET_VALUE"); }
      await symlink(join(root, ".env"), join(root, "alias.txt")); await link(join(root, ".env"), join(root, "hardlink.txt"));
      const access = new WorkspaceFileAccess(root); const policy = new WorkspaceToolAuthorizationPolicy(access);
      const provider = new FilesystemToolProvider({ root }, undefined, { name: "unsafe-index", supports: () => true, available: () => true, async search() { throw new Error("Unsafe native engine must not be used"); } }, undefined, access);
      const invoke = (toolId: string, input: JsonValue) => provider.invoke({ schemaVersion: 1, requestId: "r", toolId, input }, context());
      const result = await invoke("search", { query: "needle" }); expect(result.ok).toBe(true); expect(JSON.stringify(result)).toContain("ordinary.txt"); expect(JSON.stringify(result)).not.toContain("SECRET_VALUE");
      const listing = JSON.stringify(await invoke("list_directory", { path: "." })); expect(listing).toContain("ordinary.txt"); expect(listing).not.toContain(".env"); expect(listing).not.toContain("alias.txt"); expect(listing).not.toContain("hardlink.txt");
      for (const path of ["alias.txt", "hardlink.txt"]) { expect(await policy.authorize(request("filesystem/read_file", { path }))).toBe("deny"); expect((await invoke("read_file", { path })).ok).toBe(false); }
      await symlink(root, join(root, "directory-alias")); expect(await policy.authorize(request("filesystem/read_file", { path: "directory-alias/ordinary.txt" }))).toBe("deny");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not read or summarize sensitive content before explicit approval; denial leaks no content", async () => {
    const root = await mkdtemp(join(tmpdir(), "porta-secret-approval-"));
    try {
      await writeFile(join(root, ".env"), "SECRET_VALUE"); let summaries = 0;
      const access = new WorkspaceFileAccess(root); const provider = new FilesystemToolProvider({ root }, { async reduce(value) { summaries++; return { content: value.content, sourceChars: value.content.length }; } }, undefined, undefined, access);
      const router = new ToolRouter(); await router.register("filesystem", provider, context()); const approvals = new PendingApprovalProvider();
      const model = new ScriptedToolModelProvider([[{ type: "tool", toolId: "filesystem/read_file", input: { path: ".env", mode: "summary" } }], [{ type: "text", text: "Finished" }], [{ type: "tool", toolId: "filesystem/read_file", input: { path: ".env", mode: "summary" } }], [{ type: "text", text: "Finished" }]]);
      const gateway = new InteractiveApprovalGateway(model, router, approvals, new WorkspaceToolAuthorizationPolicy(access));
      for (const decision of ["deny", "approve"] as const) {
        const created = (await collect(gateway.execute({ type: "CreateSession" }, {})))[0] as Extract<KernelEvent, { type: "SessionCreated" }>;
        const execution = gateway.execute({ type: "SubmitInput", sessionId: created.sessionId, input: "Read the sensitive file" }, {})[Symbol.asyncIterator]();
        for (;;) { const next = await execution.next(); if (next.done) throw new Error("Missing approval"); if (next.value.type === "ApprovalRequested") { expect(summaries).toBe(0); await collect(gateway.execute({ type: "ResolveApproval", approvalId: next.value.approvalId, decision }, {})); break; } }
        await collect({ [Symbol.asyncIterator]: () => execution });
        if (decision === "deny") { expect(summaries).toBe(0); expect(JSON.stringify(model.received)).not.toContain("SECRET_VALUE"); }
        else { expect(summaries).toBe(1); expect(JSON.stringify(model.received)).toContain("SECRET_VALUE"); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("workspace mode overrides unattended job allowlists for sensitive reads and commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "porta-scope-priority-"));
    const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "fixture" }, authorization: { mode: "workspace" }, filesystem: { root, mutation: { enabled: true } }, persistence: { enabled: true, path: join(root, "state.db") }, jobs: { unattendedTools: ["filesystem/read_file", "execution/run"] } });
    await writeFile(join(root, ".env"), "SECRET_VALUE");
    const node = await createPortaNode(config, { identityDirectory: join(root, ".porta"), factories: { model: () => new ScriptedToolModelProvider([[{ type: "tool", toolId: "filesystem/write_file", input: { path: "ordinary.txt", content: "Created without approval", mode: "create" } }], [{ type: "tool", toolId: "filesystem/read_file", input: { path: ".env" } }]]) } });
    try {
      await node.application.start(); const receipt = await node.application.promptSubmission.submit({ content: "Read a secret", idempotencyKey: "protected" }, { kind: "human", identity: "test" });
      for (let i = 0; i < 100 && node.application.pendingApprovals.pendingCount === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(node.application.pendingApprovals.pendingCount).toBe(1);
      expect(node.application.pendingApprovals.pendingRequests()[0]?.toolId).toBe("filesystem/read_file");
      expect(await readFile(join(await node.application.workspaces.workspaceForSession(receipt.sessionId), "ordinary.txt"), "utf8")).toBe("Created without approval");
      expect(node.application.promptSubmission.jobs.store.get(receipt.jobId!)?.status).toBe("needs_attention");
      expect(JSON.stringify(node.application.promptSubmission.jobs.store.get(receipt.jobId!)?.activity)).not.toContain("SECRET_VALUE");
      expect(await node.application.authorizationPolicy.authorize(request("execution/run", {}))).toBe("require-approval");
    } finally { await node.close(); await rm(root, { recursive: true, force: true }); }
  });
});
