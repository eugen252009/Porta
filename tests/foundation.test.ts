import { describe, expect, it } from "vitest";
import { CapabilityRegistry, HarnessKernel, MemoryStore, MockModelProvider, capabilityDescriptorSchema, kernelEventSchema, PluginManager, RecordingRenderer } from "../src/index.js";

describe("contracts and capabilities", () => {
  it("validates schemas and resolves deterministically", () => { const descriptor = { id: "model.streaming", version: "1" }; expect(capabilityDescriptorSchema.parse(descriptor)).toEqual(descriptor); const registry = new CapabilityRegistry(); registry.register(descriptor); expect(registry.resolve({ capability: descriptor.id })).toEqual(descriptor); expect(registry.resolve({ capability: "missing", optional: true })).toBeUndefined(); expect(() => registry.resolve({ capability: "missing" })).toThrow(); expect(() => registry.register({ ...descriptor, version: "2" })).toThrow(); });
});
describe("headless vertical slice", () => {
  it("creates a session and streams ordered output", async () => { const kernel = new HarnessKernel(new MemoryStore(), new MockModelProvider((input) => `output:${input}`)); const created = await collect(kernel.execute({ type: "CreateSession" })); const sessionId = created[0]!.type === "SessionCreated" ? created[0].sessionId : ""; const events = await collect(kernel.execute({ type: "SubmitInput", sessionId, input: "hello" })); expect(events.map((event) => event.type)).toEqual(["ExecutionStarted", "OutputStarted", "OutputDelta", "OutputCompleted", "ExecutionCompleted"]); events.forEach((event) => expect(kernelEventSchema.parse(event)).toEqual(event)); });
  it("normalizes provider failures", async () => { const store = new MemoryStore(); const kernel = new HarnessKernel(store, new MockModelProvider()); const created = await collect(kernel.execute({ type: "CreateSession" })); const id = (created[0] as { sessionId: string }).sessionId; const events = await collect(kernel.execute({ type: "SubmitInput", sessionId: id, input: "error" })); expect(events.at(-1)).toMatchObject({ type: "Error", error: { code: "MODEL_FAILED" } }); });
});
 async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of source) result.push(item); return result; }

describe("plugin lifecycle", () => {
  it("starts in registration order and stops in reverse order", async () => {
    const order: string[] = [];
    const make = (id: string) => ({ manifest: { id, version: "1", provides: [{ id: `cap.${id}`, version: "1" }], requires: [] }, register() {}, initialize: async () => { order.push(`init:${id}`); }, start: async () => { order.push(`start:${id}`); }, stop: async () => { order.push(`stop:${id}`); } });
    const manager = new PluginManager(); const plugins = [make("a"), make("b")]; await manager.register(plugins); await manager.stop(plugins);
    expect(order).toEqual(["init:a", "init:b", "start:a", "start:b", "stop:b", "stop:a"]);
  });
  it("cleans up after initialization failure", async () => {
    const order: string[] = [];
    const plugin = (id: string, fails = false) => ({ manifest: { id, version: "1", provides: [{ id: `cleanup.${id}`, version: "1" }], requires: [] }, register() {}, initialize: async () => { order.push(`init:${id}`); if (fails) throw new Error("init"); }, stop: async () => { order.push(`stop:${id}`); } });
    const manager = new PluginManager(); const plugins = [plugin("a"), plugin("b", true)]; await expect(manager.register(plugins)).rejects.toThrow(); expect(order).toEqual(["init:a", "init:b", "stop:a"]);
  });
  it("propagates cancellation", async () => {
    const store = new MemoryStore(); const kernel = new HarnessKernel(store, new MockModelProvider("one two three")); const created = await collect(kernel.execute({ type: "CreateSession" })); const sessionId = (created[0] as { sessionId: string }).sessionId; const controller = new AbortController(); controller.abort(); const events = await collect(kernel.execute({ type: "SubmitInput", sessionId, input: "hello" }, { signal: controller.signal })); expect(events.at(-1)).toEqual({ type: "ExecutionCancelled" });
  });
});

describe("adapter semantics", () => {
  it("isolates stored sessions and records presentation order", async () => {
    const store = new MemoryStore(); const session = { schemaVersion: 1 as const, id: "session", state: "open" as const, createdAt: "now" }; await store.createSession(session); const loaded = await store.getSession(session.id); expect(loaded).toEqual(session); loaded!.state = "closed"; expect((await store.getSession(session.id))!.state).toBe("open");
    const renderer = new RecordingRenderer(); await renderer.render({ schemaVersion: 1, event: { type: "OutputStarted" } }); await renderer.render({ schemaVersion: 1, event: { type: "OutputCompleted" } }); expect(renderer.events.map((entry) => entry.event.type)).toEqual(["OutputStarted", "OutputCompleted"]);
  });
});
