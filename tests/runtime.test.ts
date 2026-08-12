import { describe, expect, it } from "vitest";
import { ExecutionRequest, RuntimeEvent, sandboxBindingSchema } from "../src/index.js";
import { exampleBinding, MockExternalSandbox, MockNativeSandbox, MockRuntime, MockRuntimeExecution, MockSandbox } from "../src/runtime-mocks.js";
import { RuntimeCoordinator, evaluateExecutionPolicy } from "../src/runtime.js";

const request = (source = "alpha beta"): ExecutionRequest => ({ schemaVersion: 1, source, policy: { filesystem: "deny", network: "deny" } });
const context = (signal = new AbortController().signal, deadline?: number) => ({ traceId: "trace", sessionId: "session", executionId: "execution", signal, deadline });
async function collect(source: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> { const values: RuntimeEvent[] = []; for await (const event of source) values.push(event); return values; }

describe("runtime and sandbox contracts", () => {
  it("streams deterministic events and returns a result", async () => {
    const runtime = new MockRuntime(); const sandbox = new MockSandbox(); const execution = await new RuntimeCoordinator(runtime, sandbox).createExecution(request(), context());
    expect(await collect(execution.events())).toEqual([{ type: "started", executionId: execution.id }, { type: "stdout", data: "alpha " }, { type: "stdout", data: "beta" }, { type: "exited", exitCode: 0 }, { type: "completed" }]); expect(await execution.result()).toMatchObject({ status: "completed", exitCode: 0 }); expect(sandbox.sessions[0]!.disposed).toBe(true);
  });
  it("fails closed before runtime start when a denied guarantee is unsupported", async () => {
    const runtime = new MockRuntime(); const sandbox = new MockSandbox({ network: "unsupported" });
    await expect(new RuntimeCoordinator(runtime, sandbox).createExecution(request(), context())).rejects.toMatchObject({ error: { code: "POLICY_VIOLATION" } }); expect(runtime.starts).toBe(0); expect(sandbox.creates).toBe(0);
  });
  it("supports independent runtime and sandbox substitutions", async () => {
    for (const runtime of [new MockRuntime(), new MockRuntime()]) for (const sandbox of [new MockSandbox(), new MockSandbox({ filesystem: "external" })]) {
      const execution = await new RuntimeCoordinator(runtime, sandbox).createExecution(request(), context()); await collect(execution.events()); expect((await execution.result()).status).toBe("completed");
    }
  });
  it("normalizes runtime failure and cleans up", async () => {
    const sandbox = new MockSandbox(); const execution = await new RuntimeCoordinator(new MockRuntime(true), sandbox).createExecution(request(), context()); expect((await execution.result()).status).toBe("failed"); expect(sandbox.sessions[0]!.disposed).toBe(true);
  });
  it("cancels active execution and cleans up", async () => {
    const sandbox = new MockSandbox(); const execution = await new RuntimeCoordinator(new MockRuntime(), sandbox).createExecution(request("one two three"), context()); const events = execution.events(); await events[Symbol.asyncIterator]().next(); await execution.cancel("test"); expect((await execution.result()).status).toBe("cancelled"); expect(sandbox.sessions[0]!.disposed).toBe(true);
  });
  it("rejects expired deadlines before sandbox creation", async () => {
    const sandbox = new MockSandbox(); await expect(new RuntimeCoordinator(new MockRuntime(), sandbox).createExecution(request(), context(new AbortController().signal, Date.now() - 1))).rejects.toMatchObject({ error: { code: "TIMEOUT" } }); expect(sandbox.creates).toBe(0);
  });
  it("cleans up when runtime creation fails", async () => {
    const sandbox = new MockSandbox(); const runtime = { descriptor: { id: "failing", version: "1" }, createExecution: async () => { throw new Error("create failed"); } }; await expect(new RuntimeCoordinator(runtime, sandbox).createExecution(request(), context())).rejects.toThrow("create failed"); expect(sandbox.sessions[0]!.disposed).toBe(true);
  });
  it("uses explicit enforcement levels without a secure boolean", () => { expect(evaluateExecutionPolicy({ filesystem: "deny", network: "deny" }, { filesystem: "native", network: "unsupported" }).allowed).toBe(false); expect(evaluateExecutionPolicy({ filesystem: "deny", network: "best-effort" }, { filesystem: "native", network: "unsupported" }).allowed).toBe(true); });
  it("validates the generic binding envelope and preserves serialization", () => { const binding = exampleBinding(); expect(sandboxBindingSchema.parse(JSON.parse(JSON.stringify(binding)))).toEqual(binding); expect(() => sandboxBindingSchema.parse({ schemaVersion: 1, kind: "invalid", payload: {} })).toThrow(); });
  it("consumes a matching binding and permits an external no-binding sandbox", async () => {
    const runtime = new MockRuntime(); const nativeSandbox = new MockNativeSandbox(); const nativeExecution = await new RuntimeCoordinator(runtime, nativeSandbox).createExecution(request(), context()); await collect(nativeExecution.events()); await nativeExecution.result(); expect(runtime.consumedBindings).toHaveLength(1);
    const externalExecution = await new RuntimeCoordinator(runtime, new MockExternalSandbox()).createExecution(request(), context()); await collect(externalExecution.events()); expect((await externalExecution.result()).status).toBe("completed");
  });
  it("rejects unsupported and malformed bindings before execution", async () => {
    const unsupportedRuntime = new MockRuntime(); const unsupportedSandbox = new MockNativeSandbox({ schemaVersion: 1, kind: "other.binding/v1", payload: {} }); await expect(new RuntimeCoordinator(unsupportedRuntime, unsupportedSandbox).createExecution(request(), context())).rejects.toMatchObject({ error: { code: "POLICY_VIOLATION" } }); expect(unsupportedRuntime.starts).toBe(0); expect(unsupportedSandbox.sessions[0]!.disposed).toBe(true);
    const malformedRuntime = new MockRuntime(); const malformedSandbox = new MockNativeSandbox({ schemaVersion: 1, kind: "mock.permissions/v1", payload: { mode: "invalid" } }); await expect(new RuntimeCoordinator(malformedRuntime, malformedSandbox).createExecution(request(), context())).rejects.toMatchObject({ error: { code: "SANDBOX_FAILED" } }); expect(malformedRuntime.starts).toBe(0); expect(malformedSandbox.sessions[0]!.disposed).toBe(true);
  });
});
