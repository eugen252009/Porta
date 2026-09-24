import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { InteractiveApprovalGateway } from "../src/application-gateway.js";
import { ScriptedToolModelProvider } from "../src/agent-mocks.js";
import { AllowAllToolAuthorizationPolicy, StaticToolAuthorizationPolicy } from "../src/authorization-mocks.js";
import { MemoryConversationStore } from "../src/conversation.js";
import { MockToolProvider } from "../src/tool-mocks.js";
import { ToolRouter } from "../src/tools.js";
import { ToolContext, KernelEvent } from "../src/contracts.js";
import { TerminalInputAdapter, TerminalRenderer, runTerminal } from "../src/terminal.js";

const context = (): ToolContext => ({ traceId: "trace", sessionId: "session", executionId: "execution", signal: new AbortController().signal });
async function collect(source: AsyncIterable<KernelEvent>): Promise<KernelEvent[]> { const events: KernelEvent[] = []; for await (const event of source) events.push(event); return events; }
async function session(gateway: InteractiveApprovalGateway): Promise<string> { const event = (await collect(gateway.execute({ type: "CreateSession" }, {})))[0]; return (event as Extract<KernelEvent, { type: "SessionCreated" }>).sessionId; }

function textAndHistoryProvider() {
  const provider = new ScriptedToolModelProvider([[{ type: "text", text: "Acknowledged." }], [{ type: "text", text: "Porta" }]]);
  return provider;
}

describe("Porta conversation sessions", () => {
  it("uses one conversational runtime while exposing usable tools", async () => {
    const tools = new ToolRouter(); await tools.register("scratchpad", new MockToolProvider("scratchpad"), context()); await tools.register("task", new MockToolProvider("task"), context());
    const model = new ScriptedToolModelProvider([[{ type: "text", text: "Hey there." }]]); const store = new MemoryConversationStore(); const gateway = new InteractiveApprovalGateway(model, tools, new (await import("../src/approval-pending.js")).PendingApprovalProvider(), new AllowAllToolAuthorizationPolicy(), undefined, store); const id = await session(gateway);
    await collect(gateway.execute({ type: "SubmitInput", sessionId: id, input: "hey" }, {}));
    const request = model.received[0]!; expect(request.messages).toEqual([{ role: "user", content: "hey" }]); expect(request.control?.map((entry) => entry.content).join("\n")).toContain("Use a tool only when it is necessary"); expect(request.control?.map((entry) => entry.content).join("\n")).toContain("An internal runtime job is not a user task"); expect(request.control?.map((entry) => entry.content).join("\n")).toContain("do not call task/create"); expect(request.control?.map((entry) => entry.content).join("\n")).not.toContain("P1"); expect(request.tools?.map((tool) => tool.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^task\//), expect.stringMatching(/^scratchpad\//)]));
  });

  it("does not bootstrap tools for ordinary conversational prompts", async () => {
    const model = new ScriptedToolModelProvider([[{ type: "text", text: "Hello." }], [{ type: "text", text: "Sure." }], [{ type: "text", text: "SHA-256 is a hash function." }], [{ type: "text", text: "A task scheduler coordinates work over time." }], [{ type: "text", text: "No problem." }]]); const gateway = new InteractiveApprovalGateway(model, new ToolRouter(), new (await import("../src/approval-pending.js")).PendingApprovalProvider(), new AllowAllToolAuthorizationPolicy()); const id = await session(gateway);
    const events: KernelEvent[] = []; for (const input of ["hey", "hallo", "thanks", "What is SHA-256?", "Explain what a task scheduler is."]) events.push(...await collect(gateway.execute({ type: "SubmitInput", sessionId: id, input }, {})));
    expect(model.received).toHaveLength(5); expect(events.filter((event) => event.type === "ToolRequested")).toEqual([]);
  });

  it("lets explicit requests drive tool calls without a mode classifier", async () => {
    const tools = new ToolRouter(); await tools.register("scratchpad", new MockToolProvider("scratchpad"), context());
    const model = new ScriptedToolModelProvider([[{ type: "tool", id: "note", toolId: "scratchpad/echo", input: { value: "requested" } }], [{ type: "text", text: "Done." }]]); const gateway = new InteractiveApprovalGateway(model, tools, new (await import("../src/approval-pending.js")).PendingApprovalProvider(), new AllowAllToolAuthorizationPolicy()); const id = await session(gateway);
    await collect(gateway.execute({ type: "SubmitInput", sessionId: id, input: "use the scratchpad tool" }, {}));
    expect(model.received[0]?.tools?.map((tool) => tool.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^scratchpad\//)]));
  });

  it("forwards completed text history to the next execution", async () => {
    const model = textAndHistoryProvider(); const store = new MemoryConversationStore();
    const gateway = new InteractiveApprovalGateway(model, new ToolRouter(), new (await import("../src/approval-pending.js")).PendingApprovalProvider(), new AllowAllToolAuthorizationPolicy(), undefined, store);
    const id = await session(gateway);
    await collect(gateway.execute({ type: "SubmitInput", sessionId: id, input: "Remember the project codename is Porta." }, {}));
    await collect(gateway.execute({ type: "SubmitInput", sessionId: id, input: "What is the codename?" }, {}));
    expect(model.received[1]?.messages).toEqual(expect.arrayContaining([{ role: "user", content: "Remember the project codename is Porta." }, { role: "assistant", content: "Acknowledged." }, { role: "user", content: "What is the codename?" }]));
    const saved = await store.getSession(id); expect(saved?.turns).toHaveLength(2); expect(saved?.history).toHaveLength(4);
  });

  it("preserves structured tool calls, results, and historical call IDs", async () => {
    const tools = new ToolRouter(); const provider = new MockToolProvider("provider"); await tools.register("provider", provider, context());
    const model = new ScriptedToolModelProvider([[{ type: "tool", id: "call-1", toolId: "provider/echo", input: { value: "SENTINEL-123" } }], [{ type: "text", text: "tool result accepted" }], [{ type: "text", text: "history accepted" }]]);
    const store = new MemoryConversationStore(); const gateway = new InteractiveApprovalGateway(model, tools, new (await import("../src/approval-pending.js")).PendingApprovalProvider(), new AllowAllToolAuthorizationPolicy(), undefined, store); const id = await session(gateway);
    await collect(gateway.execute({ type: "SubmitInput", sessionId: id, input: "Use the lookup tool." }, {}));
    await collect(gateway.execute({ type: "SubmitInput", sessionId: id, input: "What did it return?" }, {}));
    const history = model.received[2]?.messages ?? []; expect(history).toEqual(expect.arrayContaining([{ role: "assistant", content: undefined, toolCalls: [{ id: "call-1", toolId: "provider/echo", input: { value: "SENTINEL-123" } }] }]));
    expect(history).toEqual(expect.arrayContaining([{ role: "tool", toolCallId: "call-1", toolId: "provider/echo", result: { toolCallId: "call-1", toolId: "provider/echo", output: "SENTINEL-123" } }]));
  });

  it("isolates sessions and rejects a second active execution in one session", async () => {
    const model = new ScriptedToolModelProvider([[{ type: "text", text: "one" }], [{ type: "text", text: "two" }]]); const store = new MemoryConversationStore(); const gateway = new InteractiveApprovalGateway(model, new ToolRouter(), new (await import("../src/approval-pending.js")).PendingApprovalProvider(), new AllowAllToolAuthorizationPolicy(), undefined, store);
    const a = await session(gateway); const b = await session(gateway);
    const first = gateway.execute({ type: "SubmitInput", sessionId: a, input: "ALPHA" }, {}); const iterator = first[Symbol.asyncIterator](); await iterator.next();
    expect((await collect(gateway.execute({ type: "SubmitInput", sessionId: a, input: "again" }, {})))[0]).toMatchObject({ type: "Error", error: { code: "CAPABILITY_CONFLICT" } });
    await collect({ [Symbol.asyncIterator]: () => iterator });
    await collect(gateway.execute({ type: "SubmitInput", sessionId: b, input: "BETA" }, {}));
    expect((await store.getSession(a))?.history).toEqual(expect.arrayContaining([{ role: "user", content: "ALPHA" }]));
    expect((await store.getSession(a))?.history).not.toEqual(expect.arrayContaining([{ role: "user", content: "BETA" }]));
    expect((await store.getSession(b))?.history).toEqual(expect.arrayContaining([{ role: "user", content: "BETA" }]));
  });

  it("does not commit cancelled turns and trims only complete turns", async () => {
    const store = new MemoryConversationStore({ maxTurns: 1 }); const firstModel = textAndHistoryProvider(); const gateway = new InteractiveApprovalGateway(firstModel, new ToolRouter(), new (await import("../src/approval-pending.js")).PendingApprovalProvider(), new AllowAllToolAuthorizationPolicy(), undefined, store); const id = await session(gateway);
    await collect(gateway.execute({ type: "SubmitInput", sessionId: id, input: "first" }, {})); await collect(gateway.execute({ type: "SubmitInput", sessionId: id, input: "second" }, {}));
    const snapshot = await store.snapshot(id); expect(snapshot.turnsAvailable).toBe(2); expect(snapshot.turnsIncluded).toBe(1); expect(snapshot.turnsDropped).toBe(1); expect(snapshot.history).not.toEqual(expect.arrayContaining([{ role: "user", content: "first" }]));
    const blocking = new ScriptedToolModelProvider([[{ type: "text", text: "never" }]]); const blockedGateway = new InteractiveApprovalGateway(blocking, new ToolRouter(), new (await import("../src/approval-pending.js")).PendingApprovalProvider(), new AllowAllToolAuthorizationPolicy(), undefined, store); const blocked = await session(blockedGateway); const stream = blockedGateway.execute({ type: "SubmitInput", sessionId: blocked, input: "cancel me" }); const iterator = stream[Symbol.asyncIterator](); await iterator.next(); await collect(blockedGateway.execute({ type: "CancelExecution", sessionId: blocked }, {})); expect((await store.getSession(blocked))?.history).toHaveLength(0);
  });

  it("carries history through the real terminal application loop", async () => {
    const model = textAndHistoryProvider(); const store = new MemoryConversationStore(); const gateway = new InteractiveApprovalGateway(model, new ToolRouter(), new (await import("../src/approval-pending.js")).PendingApprovalProvider(), new AllowAllToolAuthorizationPolicy(), undefined, store);
    const input = new PassThrough(); const output = new PassThrough(); let rendered = ""; output.on("data", (chunk) => { rendered += chunk.toString(); }); input.end("first prompt\nsecond prompt\n");
    await runTerminal(gateway, new TerminalInputAdapter(input), new TerminalRenderer(output), output);
    expect(rendered).toContain("Porta ready."); expect(model.received[1]?.messages).toEqual(expect.arrayContaining([{ role: "user", content: "first prompt" }, { role: "assistant", content: "Acknowledged." }]));
  });

  it("keeps a denied tool result in a successfully completed turn", async () => {
    const tools = new ToolRouter(); await tools.register("provider", new MockToolProvider("provider"), context()); const model = new ScriptedToolModelProvider([[{ type: "tool", id: "denied-call", toolId: "provider/echo", input: { value: "x" } }], [{ type: "text", text: "denial handled" }]]); const store = new MemoryConversationStore(); const gateway = new InteractiveApprovalGateway(model, tools, new (await import("../src/approval-pending.js")).PendingApprovalProvider(), new StaticToolAuthorizationPolicy("deny"), undefined, store); const id = await session(gateway);
    await collect(gateway.execute({ type: "SubmitInput", sessionId: id, input: "try tool" }, {})); const saved = await store.getSession(id); expect(saved?.history).toEqual(expect.arrayContaining([{ role: "tool", toolCallId: "denied-call", toolId: "provider/echo", result: expect.objectContaining({ error: expect.objectContaining({ code: "AUTHORIZATION_DENIED" }) }) }]));
  });
});
