import { describe, expect, it } from "vitest";
import { InteractiveApprovalGateway } from "../src/application-gateway.js";
import { ScriptedToolModelProvider } from "../src/agent-mocks.js";
import { AllowAllToolAuthorizationPolicy } from "../src/authorization-mocks.js";
import { PendingApprovalProvider } from "../src/approval-pending.js";
import { MemoryConversationStore } from "../src/conversation.js";
import { DeterministicConversationCompactor, ConversationCompactor } from "../src/compaction.js";
import { MemoryScratchpadStore, ScratchpadToolProvider } from "../src/scratchpad.js";
import { HarnessFailure, KernelEvent, ToolContext } from "../src/contracts.js";
import { ToolRouter } from "../src/tools.js";

async function collect(source: AsyncIterable<KernelEvent>): Promise<KernelEvent[]> { const result: KernelEvent[] = []; for await (const event of source) result.push(event); return result; }
async function createSession(gateway: InteractiveApprovalGateway): Promise<string> { const event = (await collect(gateway.execute({ type: "CreateSession" }, {})))[0] as Extract<KernelEvent, { type: "SessionCreated" }>; return event.sessionId; }
const context = (sessionId: string): ToolContext => ({ traceId: "trace", sessionId, executionId: "execution", signal: new AbortController().signal });

function setup(compactor: ConversationCompactor = new DeterministicConversationCompactor()) {
  const model = new ScriptedToolModelProvider([[{ type: "text", text: "turn one" }], [{ type: "text", text: "turn two" }], [{ type: "text", text: "turn three" }], [{ type: "text", text: "turn four" }]]);
  const conversations = new MemoryConversationStore({ maxTurns: 1 }); const scratchpad = new MemoryScratchpadStore();
  const gateway = new InteractiveApprovalGateway(model, new ToolRouter(), new PendingApprovalProvider(), new AllowAllToolAuthorizationPolicy(), undefined, conversations, { enabled: true, threshold: 1, keepRecentTurns: 1, maxManifestEntries: 2, compactor, scratchpad });
  return { gateway, model, conversations, scratchpad };
}

describe("conversation compaction", () => {
  it("keeps canonical history, recent turns, recovery hint, and bounded scratchpad manifest", async () => {
    const { gateway, model, conversations, scratchpad } = setup(); const sessionId = await createSession(gateway); await scratchpad.write(sessionId, "important", "SCRATCHPAD_DURABLE_SENTINEL_8127"); await scratchpad.write(sessionId, "other", "other note"); await scratchpad.write(sessionId, "third", "third note");
    await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "first" }, {})); await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "second" }, {})); await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "third" }, {}));
    const request = model.received[2]!; const control = request.control?.map((message) => message.content).join("\n") ?? "";
    expect(control).toContain("Conversation history was compacted"); expect(control).toContain("scratchpad/search"); expect(control).toContain("important"); expect(control).toContain("... 1 more entries"); expect(control).not.toContain("SCRATCHPAD_DURABLE_SENTINEL_8127");
    expect(request.messages).toEqual(expect.arrayContaining([{ role: "user", content: "second" }, { role: "assistant", content: "turn two" }, { role: "user", content: "third" }]));
    expect((await conversations.getSession(sessionId))?.turns).toHaveLength(3); expect((await scratchpad.read(sessionId, "important"))?.content).toBe("SCRATCHPAD_DURABLE_SENTINEL_8127");
  });

  it("does not add recovery control before compaction and restores notes only explicitly", async () => {
    const { gateway, model, scratchpad } = setup(); const sessionId = await createSession(gateway); await scratchpad.write(sessionId, "note", "PRIVATE_NOTE"); await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "first" }, {}));
    expect(model.received[0]?.control).toEqual([]); expect(JSON.stringify(model.received[0])).not.toContain("PRIVATE_NOTE");
    const notes = new ScratchpadToolProvider(scratchpad); const read = await notes.invoke({ schemaVersion: 1, requestId: "read", toolId: "read", input: { key: "note" } }, context(sessionId)); expect(JSON.stringify(read)).toContain("PRIVATE_NOTE");
  });

  it("falls back to deterministic recent history when compaction fails", async () => {
    const failing: ConversationCompactor = { compact: async () => { throw new Error("compactor unavailable"); } }; const { gateway, model } = setup(failing); const sessionId = await createSession(gateway); await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "first" }, {})); await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "second" }, {})); await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "third" }, {})); expect(model.received[2]?.control).toEqual([]); expect(model.received[2]?.messages).toEqual(expect.arrayContaining([{ role: "user", content: "second" }]));
  });

  it("does not start an execution when compaction times out", async () => {
    const timedOut: ConversationCompactor = { compact: async () => { throw new HarnessFailure({ code: "TIMEOUT", message: "compaction timeout", retryable: true }); } }; const { gateway, model } = setup(timedOut); const sessionId = await createSession(gateway); await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "first" }, {})); await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "second" }, {})); const events = await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "third" }, {})); expect(events.at(-1)).toMatchObject({ type: "Error", error: { code: "TIMEOUT" } }); expect(model.received).toHaveLength(2);
  });

  it("does not start an execution when compaction is cancelled", async () => {
    const { gateway, model } = setup(); const sessionId = await createSession(gateway); await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "first" }, {})); await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "second" }, {})); const controller = new AbortController(); controller.abort(); const events = await collect(gateway.execute({ type: "SubmitInput", sessionId, input: "third" }, { signal: controller.signal })); expect(events.at(-1)).toMatchObject({ type: "Error", error: { code: "CANCELLED" } }); expect(model.received).toHaveLength(2);
  });
});
