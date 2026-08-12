import { z } from "zod";
import { ExecutionContext, ExecutionRequest, ExecutionResult, HarnessError, HarnessPlugin, RuntimeEvent, RuntimeExecution, RuntimeHost, SandboxBinding, SandboxCapabilities, SandboxProvider, SandboxSession, failure } from "./contracts.js";
import { executionId } from "./runtime.js";

class EventQueue<T> {
  private readonly values: T[] = []; private waiter?: (result: IteratorResult<T>) => void; private done = false;
  push(value: T) { if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value, done: false }); } else this.values.push(value); }
  close() { this.done = true; this.waiter?.({ value: undefined as T, done: true }); this.waiter = undefined; }
  async next(): Promise<IteratorResult<T>> { if (this.values.length) return { value: this.values.shift()!, done: false }; if (this.done) return { value: undefined as T, done: true }; return new Promise((resolve) => { this.waiter = resolve; }); }
}

export class MockRuntimeExecution implements RuntimeExecution {
  readonly id = executionId(); private readonly queue = new EventQueue<RuntimeEvent>(); private readonly completion: Promise<ExecutionResult>; private finish!: (result: ExecutionResult) => void; private cancelled = false; private started = false;
  constructor(private readonly request: ExecutionRequest, private readonly context: ExecutionContext, private readonly fail = false) { this.completion = new Promise((resolve) => { this.finish = resolve; }); }
  events(): AsyncIterable<RuntimeEvent> { if (!this.started) { this.started = true; void this.run(); } const queue = this.queue; return { [Symbol.asyncIterator]: () => ({ next: () => queue.next() }) }; }
  async cancel(): Promise<void> { this.cancelled = true; }
  result(): Promise<ExecutionResult> { if (!this.started) { this.started = true; void this.run(); } return this.completion; }
  private async run() {
    this.queue.push({ type: "started", executionId: this.id });
    if (this.fail) { const error = failure("RUNTIME_FAILED", "Mock runtime failure."); this.queue.push({ type: "failed", error: error.error }); this.finish({ executionId: this.id, status: "failed", error: error.error }); this.queue.close(); return; }
    const output = this.request.source ?? "mock output";
    for (const part of output.split(" ")) {
      await Promise.resolve();
      if (this.cancelled || this.context.signal.aborted) { this.queue.push({ type: "cancelled" }); this.finish({ executionId: this.id, status: "cancelled" }); this.queue.close(); return; }
      if (this.context.deadline !== undefined && this.context.deadline <= Date.now()) { const error: HarnessError = { code: "TIMEOUT", message: "Mock runtime deadline exceeded.", retryable: true }; this.queue.push({ type: "failed", error }); this.finish({ executionId: this.id, status: "timed-out", error }); this.queue.close(); return; }
      this.queue.push({ type: "stdout", data: `${part}${part === output.split(" ").at(-1) ? "" : " "}` });
    }
    this.queue.push({ type: "exited", exitCode: 0 }); this.queue.push({ type: "completed" }); this.finish({ executionId: this.id, status: "completed", exitCode: 0, output }); this.queue.close();
  }
}

export class MockRuntime implements RuntimeHost {
  readonly descriptor = { id: "mock-runtime", version: "1" }; readonly supportedBindingKinds = ["mock.permissions/v1"]; starts = 0; consumedBindings: SandboxBinding[] = []; constructor(private readonly fail = false) {}
  async createExecution(request: ExecutionRequest, context: ExecutionContext, sandbox: SandboxSession): Promise<RuntimeExecution> { if (sandbox.binding) { const parsed = ExampleBindingPayloadSchema.safeParse(sandbox.binding.payload); if (!parsed.success) throw failure("SANDBOX_FAILED", "Mock runtime received an invalid binding payload."); this.consumedBindings.push(sandbox.binding); } this.starts++; return new MockRuntimeExecution(request, context, this.fail); }
}

export class MockSandboxSession implements SandboxSession { readonly id = executionId(); disposed = false; constructor(readonly binding?: SandboxBinding) {} async dispose() { this.disposed = true; } }
export class MockSandbox implements SandboxProvider {
  readonly descriptor = { id: "mock-sandbox", version: "1" }; readonly capabilities: SandboxCapabilities; creates = 0; readonly sessions: MockSandboxSession[] = [];
  constructor(capabilities: Partial<SandboxCapabilities> = {}, private readonly binding?: SandboxBinding) { this.capabilities = { filesystem: "native", network: "native", ...capabilities }; }
  async create(_policy: ExecutionRequest["policy"]): Promise<SandboxSession> { this.creates++; const session = new MockSandboxSession(this.binding); this.sessions.push(session); return session; }
}

export const ExampleBindingPayloadSchema = z.object({ mode: z.enum(["restricted", "unrestricted"]) });
export const exampleBinding = (mode: "restricted" | "unrestricted" = "restricted"): SandboxBinding => ({ schemaVersion: 1, kind: "mock.permissions/v1", payload: { mode } });
export class MockExternalSandbox extends MockSandbox { constructor() { super(); } }
export class MockNativeSandbox extends MockSandbox { constructor(binding: SandboxBinding = exampleBinding()) { super({}, binding); } }

export function mockRuntimePlugin(runtime: RuntimeHost): HarnessPlugin { return { manifest: { schemaVersion: 1, id: "runtime.mock", version: "1", provides: [{ id: "runtime.execution", version: "1" }, { id: "runtime.streaming", version: "1" }, { id: "runtime.binding.mock-permissions.v1", version: "1" }], requires: [] }, register(registrar) { registrar.provide({ id: "runtime.execution", version: "1" }, runtime); registrar.provide({ id: "runtime.streaming", version: "1" }, runtime); registrar.provide({ id: "runtime.binding.mock-permissions.v1", version: "1" }, runtime); } }; }
export function mockSandboxPlugin(sandbox: SandboxProvider): HarnessPlugin { return { manifest: { schemaVersion: 1, id: "sandbox.mock", version: "1", provides: [{ id: "sandbox.filesystem", version: "1" }, { id: "sandbox.network", version: "1" }], requires: sandbox instanceof MockNativeSandbox ? [{ capability: "runtime.binding.mock-permissions.v1" }] : [] }, register(registrar) { registrar.provide({ id: "sandbox.filesystem", version: "1" }, sandbox); registrar.provide({ id: "sandbox.network", version: "1" }, sandbox); } }; }
