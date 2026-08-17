import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentOrchestrator } from "../src/agent.js";
import { ScriptedToolModelProvider } from "../src/agent-mocks.js";
import { PendingApprovalProvider } from "../src/approval-pending.js";
import { InteractiveApprovalGateway } from "../src/application-gateway.js";
import { StaticToolAuthorizationPolicy } from "../src/authorization-mocks.js";
import { MCPToolProvider } from "../src/adapters/tool-mcp.js";
import { OpenAICompatibleModelProvider } from "../src/adapters/model-openai-compatible.js";
import { ToolContext, kernelEventSchema } from "../src/index.js";
import { MockToolProvider } from "../src/tool-mocks.js";
import { ToolRouter } from "../src/tools.js";

const context = (signal = new AbortController().signal, deadline?: number): ToolContext => ({ traceId: "trace", sessionId: "session", executionId: "execution", signal, deadline });
const modelScript = (id: string, toolId = "provider/echo") => [[{ type: "tool" as const, id, toolId, input: { value: id } }], [{ type: "text" as const, text: "continued" }]];
async function setup() { const provider = new MockToolProvider("provider"); const tools = new ToolRouter(); await tools.register("provider", provider, context()); const pending = new PendingApprovalProvider(); const gateway = new InteractiveApprovalGateway(new ScriptedToolModelProvider(modelScript("call-1")), tools, pending, new StaticToolAuthorizationPolicy("require-approval")); const created = [...(await collect(gateway.execute({ type: "CreateSession" })))]; const sessionId = (created[0] as { sessionId: string }).sessionId; return { gateway, pending, tools, provider, sessionId }; }
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }
async function nextUntil<T extends { type: string }>(iterator: AsyncIterator<T>, type: string): Promise<T> { for (;;) { const item = await iterator.next(); if (item.done) throw new Error(`Expected ${type}`); if (item.value.type === type) return item.value; } }

describe("interactive approval gateway", () => {
  it("keeps execution pending, then approves exactly once through the command", async () => {
    const { gateway, pending, provider, sessionId } = await setup(); const stream = gateway.execute({ type: "SubmitInput", sessionId, input: "input" }); const iterator = stream[Symbol.asyncIterator](); const requested = await nextUntil(iterator, "ApprovalRequested") as Extract<import("../src/index.js").KernelEvent, { type: "ApprovalRequested" }>; expect(requested.approvalId).toBeTruthy(); expect(pending.pendingCount).toBe(1); expect(provider.calls).toHaveLength(0);
    kernelEventSchema.parse(requested); const before = await Promise.race([iterator.next().then(() => "event"), new Promise((resolve) => setTimeout(() => resolve("pending"), 10))]); expect(before).toBe("pending"); const command = await collect(gateway.execute({ type: "ResolveApproval", approvalId: requested.approvalId, decision: "approve" })); expect(command[0]).toMatchObject({ type: "ApprovalResolved", approvalId: requested.approvalId, decision: "approve" }); kernelEventSchema.parse(command[0]); const events = await collect({ [Symbol.asyncIterator]: () => iterator }); expect(events.map((event) => event.type)).toContain("ToolCompleted"); expect(provider.calls).toHaveLength(1); expect(pending.pendingCount).toBe(0);
    expect((await collect(gateway.execute({ type: "ResolveApproval", approvalId: requested.approvalId, decision: "deny" })))[0]?.type).toBe("Error");
  });

  it("denies without tool events or invocation and rejects unknown/invalid commands", async () => {
    const { gateway, provider, sessionId } = await setup(); const stream = gateway.execute({ type: "SubmitInput", sessionId, input: "input" }); const iterator = stream[Symbol.asyncIterator](); const requested = await nextUntil(iterator, "ApprovalRequested") as Extract<import("../src/index.js").KernelEvent, { type: "ApprovalRequested" }>; const result = await collect(gateway.execute({ type: "ResolveApproval", approvalId: requested.approvalId, decision: "deny", reason: "not now" })); expect(result[0]).toMatchObject({ type: "ApprovalResolved", decision: "deny" }); const events = await collect({ [Symbol.asyncIterator]: () => iterator }); expect(events.some((event) => event.type === "ToolStarted" || event.type === "ToolCompleted")).toBe(false); expect(provider.calls).toHaveLength(0); expect((await collect(gateway.execute({ type: "ResolveApproval", approvalId: "missing", decision: "approve" })))[0]?.type).toBe("Error"); expect((await collect(gateway.execute({ type: "ResolveApproval", approvalId: "", decision: "approve" })))[0]?.type).toBe("Error");
  });

  it("isolates concurrent executions by approval ID", async () => {
    const provider = new MockToolProvider("provider"); const tools = new ToolRouter(); await tools.register("provider", provider, context()); const pending = new PendingApprovalProvider(); const subscription = pending.subscribe()[Symbol.asyncIterator](); const first = new AgentOrchestrator(new ScriptedToolModelProvider([callTurn("a"), [{ type: "text" as const, text: "done" }]]), tools, undefined, { policy: new StaticToolAuthorizationPolicy("require-approval"), approvalProvider: pending }).create("a", context(), tools.listTools()); const second = new AgentOrchestrator(new ScriptedToolModelProvider([callTurn("b"), [{ type: "text" as const, text: "done" }]]), tools, undefined, { policy: new StaticToolAuthorizationPolicy("require-approval"), approvalProvider: pending }).create("b", { ...context(), executionId: "second" }, tools.listTools()); const firstApproval = await nextUntil(subscription, "ApprovalRequested") as Extract<import("../src/index.js").PendingApprovalEvent, { type: "ApprovalRequested" }>; const secondApproval = await nextUntil(subscription, "ApprovalRequested") as Extract<import("../src/index.js").PendingApprovalEvent, { type: "ApprovalRequested" }>; expect(firstApproval.approvalId).not.toBe(secondApproval.approvalId); pending.resolve(firstApproval.approvalId, { decision: "approve" }); await new Promise((resolve) => setTimeout(resolve, 5)); expect(provider.calls).toHaveLength(1); expect(pending.pendingCount).toBe(1); pending.resolve(secondApproval.approvalId, { decision: "deny" }); expect((await first.result()).status).toBe("completed"); expect((await second.result()).status).toBe("completed");
  });

  it("cleans pending approval on cancellation and deadline", async () => {
    const { tools, pending, provider } = await setup(); const cancelledController = new AbortController(); const cancelled = new AgentOrchestrator(new ScriptedToolModelProvider(modelScript("cancel")), tools, undefined, { policy: new StaticToolAuthorizationPolicy("require-approval"), approvalProvider: pending }).create("cancel", context(cancelledController.signal), tools.listTools()); await new Promise((resolve) => setTimeout(resolve, 0)); expect(pending.pendingCount).toBe(1); await cancelled.cancel(); expect((await cancelled.result()).status).toBe("cancelled"); expect(pending.pendingCount).toBe(0); expect(provider.calls).toHaveLength(0);
    const timed = new AgentOrchestrator(new ScriptedToolModelProvider(modelScript("timeout")), tools, undefined, { policy: new StaticToolAuthorizationPolicy("require-approval"), approvalProvider: pending }).create("timeout", context(new AbortController().signal, Date.now() + 5), tools.listTools()); expect((await timed.result()).status).toBe("timed-out"); expect(pending.pendingCount).toBe(0); expect(provider.calls).toHaveLength(0);
  });

  it("cancels a gateway execution through the canonical command", async () => {
    const { gateway, pending, sessionId } = await setup(); const stream = gateway.execute({ type: "SubmitInput", sessionId, input: "input" }); const iterator = stream[Symbol.asyncIterator](); await nextUntil(iterator, "ApprovalRequested"); expect(pending.pendingCount).toBe(1); await collect(gateway.execute({ type: "CancelExecution", sessionId })); expect(pending.pendingCount).toBe(0); const events = await collect({ [Symbol.asyncIterator]: () => iterator }); expect(events.at(-1)).toMatchObject({ type: "ExecutionCancelled" });
  });

  it("accepts exactly one of concurrent conflicting resolutions", async () => {
    const pending = new PendingApprovalProvider(); const request = { approvalId: "approval-race", toolCallId: "call", invocation: { schemaVersion: 1 as const, requestId: "call", toolId: "provider/echo", input: {} }, context: context() }; const waiting = pending.approve(request); const outcomes = await Promise.allSettled([Promise.resolve().then(() => pending.resolve(request.approvalId, { decision: "approve" })), Promise.resolve().then(() => pending.resolve(request.approvalId, { decision: "deny" }))]); expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1); expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1); expect((await waiting).approved).toBe(true); expect(pending.pendingCount).toBe(0);
  });

  it("routes adapter-mapped tool calls by canonical identity when local ids collide", async () => {
    const first = new MockToolProvider("provider-a"); const second = new MockToolProvider("server-b");
    const tools = new ToolRouter(); await tools.register("provider-a", first, context()); await tools.register("server-b", second, context());
    const target = tools.listTools().findIndex((tool) => tool.canonicalId === "server-b/echo");
    const sse = (payload: string) => `data: ${payload}\n\n`;
    const turns: string[][] = [
      [sse(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"harness_tool_${target}","arguments":"{\\"value\\":\\"scoped\\"}"}}]}}]}`), "data: [DONE]\n\n"],
      [sse('{"choices":[{"delta":{"content":"routed"}}]}'), "data: [DONE]\n\n"],
    ];
    let turn = 0;
    const fetchLike = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      const body = new ReadableStream<Uint8Array>({ start(controller) { const encoder = new TextEncoder(); for (const chunk of turns[turn++ % turns.length]!) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
      return { ok: true, status: 200, body, json: async () => ({}) } as Response;
    };
    const model = new OpenAICompatibleModelProvider({ baseUrl: "http://model.test/v1", model: "local-model" }, fetchLike);
    const gateway = new InteractiveApprovalGateway(model, tools, new PendingApprovalProvider(), new StaticToolAuthorizationPolicy("allow"));
    const session = (await collect(gateway.execute({ type: "CreateSession" })))[0] as { sessionId: string };
    const events = await collect(gateway.execute({ type: "SubmitInput", sessionId: session.sessionId, input: "route it" }));
    const completed = events.find((event) => event.type === "ToolCompleted") as { toolId: string; result: { output?: string; error?: { code: string } } } | undefined;
    expect(completed?.toolId).toBe("server-b/echo");
    expect(completed?.result).toMatchObject({ output: "scoped" });
    expect(completed?.result?.error).toBeUndefined();
    expect(second.calls).toEqual(["echo"]);
    expect(first.calls).toEqual([]);
  });

  it("qualifies real MCP approve and deny paths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "harness-gateway-mcp-")); const countFile = join(directory, "calls"); const provider = new MCPToolProvider({ providerId: "fixture", command: process.execPath, args: [new URL("../dist/tests/mcp-fixture-server.js", import.meta.url).pathname], env: { ...process.env, MCP_CALL_COUNT_FILE: countFile } }); const tools = new ToolRouter(); const pending = new PendingApprovalProvider();
    try {
      await tools.register("fixture", provider, context()); const gateway = new InteractiveApprovalGateway(new ScriptedToolModelProvider([[{ type: "tool", id: "mcp", toolId: "fixture/echo", input: { value: "approved" } }], [{ type: "text", text: "mcp done" }]]), tools, pending, new StaticToolAuthorizationPolicy("require-approval")); const session = (await collect(gateway.execute({ type: "CreateSession" })))[0] as { sessionId: string }; const stream = gateway.execute({ type: "SubmitInput", sessionId: session.sessionId, input: "mcp" }); const iterator = stream[Symbol.asyncIterator](); const requested = await nextUntil(iterator, "ApprovalRequested") as Extract<import("../src/index.js").KernelEvent, { type: "ApprovalRequested" }>; await collect(gateway.execute({ type: "ResolveApproval", approvalId: requested.approvalId, decision: "approve" })); await collect({ [Symbol.asyncIterator]: () => iterator }); expect(readFileSync(countFile, "utf8").trim().split("\n")).toHaveLength(1);
      const deniedPending = new PendingApprovalProvider(); const deniedGateway = new InteractiveApprovalGateway(new ScriptedToolModelProvider([[{ type: "tool", id: "mcp-deny", toolId: "fixture/echo", input: { value: "denied" } }], [{ type: "text", text: "denied handled" }]]), tools, deniedPending, new StaticToolAuthorizationPolicy("require-approval")); const deniedSession = (await collect(deniedGateway.execute({ type: "CreateSession" })))[0] as { sessionId: string }; const deniedStream = deniedGateway.execute({ type: "SubmitInput", sessionId: deniedSession.sessionId, input: "mcp" }); const deniedIterator = deniedStream[Symbol.asyncIterator](); const deniedRequest = await nextUntil(deniedIterator, "ApprovalRequested") as Extract<import("../src/index.js").KernelEvent, { type: "ApprovalRequested" }>; await collect(deniedGateway.execute({ type: "ResolveApproval", approvalId: deniedRequest.approvalId, decision: "deny" })); await collect({ [Symbol.asyncIterator]: () => deniedIterator }); expect(readFileSync(countFile, "utf8").trim().split("\n")).toHaveLength(1);
    } finally { await provider.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

function callTurn(id: string) { return [{ type: "tool" as const, id, toolId: "provider/echo", input: { value: id } }]; }
