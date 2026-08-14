import { randomUUID } from "node:crypto";
import { AllowAllToolAuthorizationPolicy } from "./authorization-mocks.js";
import { ApprovalProvider, HarnessFailure, ModelContext, ModelMessage, ModelProvider, ModelRequest, ModelToolCall, ModelToolResult, ToolAuthorizationPolicy, ToolContext, ToolDescriptor, ToolResult, failure, modelToolCallSchema } from "./contracts.js";
import { ToolRouter } from "./tools.js";

export interface AgentLimits { maxSteps: number; maxToolCalls: number }
export interface AgentExecutionResult { executionId: string; status: "completed" | "failed" | "cancelled" | "timed-out" | "limit-reached"; text?: string; messages?: readonly ModelMessage[]; error?: import("./contracts.js").HarnessError }
export type AgentEvent = { type: "started"; executionId: string } | { type: "model-started"; step: number } | { type: "model-text"; text: string } | { type: "tool-requested"; toolCallId: string; toolId: string } | { type: "tool-started"; toolCallId: string; toolId: string } | { type: "tool-completed"; toolCallId: string; toolId: string; result: ModelToolResult } | { type: "completed"; text?: string } | { type: "failed"; error: import("./contracts.js").HarnessError } | { type: "cancelled" } | { type: "timed-out" } | { type: "limit-reached" };
export interface AgentExecution { readonly id: string; events(): AsyncIterable<AgentEvent>; cancel(reason?: string): Promise<void>; result(): Promise<AgentExecutionResult> }
export interface AgentAuthorizationOptions { policy?: ToolAuthorizationPolicy; approvalProvider?: ApprovalProvider }

export class AgentOrchestrator {
  constructor(private readonly model: ModelProvider, private readonly tools?: ToolRouter, private readonly limits: AgentLimits = { maxSteps: 8, maxToolCalls: 16 }, private readonly authorization: AgentAuthorizationOptions = {}) {}
  create(input: string, context: ModelContext, descriptors: readonly ToolDescriptor[] = [], history: readonly ModelMessage[] = []): AgentExecution { return new ManagedAgent(this.model, this.tools, this.limits, this.authorization, input, context, descriptors, history); }
}

class ManagedAgent implements AgentExecution {
  readonly id = randomUUID(); private readonly queue = new AsyncQueue<AgentEvent>(); private readonly completion: Promise<AgentExecutionResult>; private resolveResult!: (result: AgentExecutionResult) => void; private terminalCause?: "cancelled" | "timed-out" | "limit-reached"; private terminal = false; private readonly controller = new AbortController(); private running: Promise<void>;
  constructor(private readonly model: ModelProvider, private readonly tools: ToolRouter | undefined, private readonly limits: AgentLimits, private readonly authorization: AgentAuthorizationOptions, private readonly input: string, private readonly parent: ModelContext, private readonly descriptors: readonly ToolDescriptor[], private readonly initialHistory: readonly ModelMessage[]) { this.completion = new Promise((resolve) => { this.resolveResult = resolve; }); parent.signal.addEventListener("abort", () => this.stop("cancelled"), { once: true }); if (parent.deadline !== undefined) setTimeout(() => this.stop("timed-out"), Math.max(0, parent.deadline - Date.now())); this.running = this.run(); }
  events(): AsyncIterable<AgentEvent> { return this.queue; }
  async cancel(): Promise<void> { this.stop("cancelled"); await this.running; }
  result(): Promise<AgentExecutionResult> { return this.completion; }
  private stop(cause: "cancelled" | "timed-out" | "limit-reached") { if (!this.terminalCause) this.terminalCause = cause; this.controller.abort(); }
  private childContext(): ModelContext { return { ...this.parent, executionId: this.id, signal: this.controller.signal }; }
  private async run() {
    this.push({ type: "started", executionId: this.id });
    const messages: ModelMessage[] = [...this.initialHistory, { role: "user", content: this.input }];
    const transcript: ModelMessage[] = [{ role: "user", content: this.input }];
    const seen = new Set<string>(); let text = ""; let toolCalls = 0;
    try {
      for (let step = 1; step <= this.limits.maxSteps; step++) {
        if (this.terminalCause) return this.finishCause();
        this.push({ type: "model-started", step });
        const request: ModelRequest = { schemaVersion: 1, requestId: randomUUID(), input: this.input, messages: [...messages], tools: this.descriptors };
        const turnCalls: ModelToolCall[] = []; let turnText = "";
        for await (const event of this.model.generate(request, this.childContext())) {
          if (this.terminalCause) return this.finishCause();
          if (event.type === "delta") { text += event.text; turnText += event.text; this.push({ type: "model-text", text: event.text }); }
          else if (event.type === "tool-call") {
            const parsed = modelToolCallSchema.safeParse(event.call); if (!parsed.success) throw failure("MODEL_FAILED", "Model emitted an invalid tool call.", false, { issues: parsed.error.issues });
            const call = event.call; if (seen.has(call.id)) throw failure("MODEL_FAILED", `Model repeated tool call '${call.id}'.`); seen.add(call.id);
            if (!this.tools) throw failure("CAPABILITY_UNAVAILABLE", "Tool use is unavailable for this execution.");
            if (++toolCalls > this.limits.maxToolCalls) { this.stop("limit-reached"); return this.finishCause(); }
            turnCalls.push(call); this.push({ type: "tool-requested", toolCallId: call.id, toolId: call.toolId });
          }
        }
        if (turnCalls.length) {
          const assistant: ModelMessage = { role: "assistant", content: turnText || undefined, toolCalls: turnCalls };
          messages.push(assistant); transcript.push(assistant);
          for (const call of turnCalls) {
            const invocation = Object.freeze({ schemaVersion: 1 as const, requestId: call.id, toolId: call.toolId, input: call.input });
            const result = await this.authorize(call, invocation);
            if (result.error?.code === "CANCELLED") { this.stop("cancelled"); return this.finishCause(); }
            if (result.error?.code === "TIMEOUT") { this.stop("timed-out"); return this.finishCause(); }
            const denied = result.error?.code === "AUTHORIZATION_DENIED" || result.error?.code === "POLICY_VIOLATION";
            if (!denied && result.error?.code !== "CAPABILITY_UNAVAILABLE") this.push({ type: "tool-started", toolCallId: call.id, toolId: call.toolId });
            const modelResult: ModelToolResult = { toolCallId: call.id, toolId: call.toolId, output: result.output ?? null, ...(result.error ? { error: result.error } : {}) };
            const toolMessage: ModelMessage = { role: "tool", toolCallId: call.id, toolId: call.toolId, result: modelResult };
            messages.push(toolMessage); transcript.push(toolMessage);
            if (!denied && result.error?.code !== "CAPABILITY_UNAVAILABLE") this.push({ type: "tool-completed", toolCallId: call.id, toolId: call.toolId, result: modelResult });
          }
        } else {
          if (turnText) { const assistant: ModelMessage = { role: "assistant", content: turnText }; messages.push(assistant); transcript.push(assistant); }
          return this.finish({ executionId: this.id, status: "completed", text, messages: freezeMessages(transcript) });
        }
      }
      this.stop("limit-reached"); return this.finishCause();
    } catch (error) {
      if (this.terminalCause) return this.finishCause();
      return this.finish({ executionId: this.id, status: "failed", error: error instanceof HarnessFailure ? error.error : failure("MODEL_FAILED", error instanceof Error ? error.message : "Agent execution failed.").error });
    }
  }
  private toolContext(): ToolContext { return { ...this.parent, executionId: this.id, signal: this.controller.signal }; }
  private async authorize(call: ModelToolCall, invocation: import("./contracts.js").ToolInvocation): Promise<ToolResult> { const descriptor = this.tools?.descriptorFor(call.toolId); const request = { toolCallId: call.id, invocation, descriptor, context: this.toolContext() }; if (!this.tools) return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", "Tool use is unavailable for this execution.").error }; if (!descriptor) return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", `Tool '${call.toolId}' is unavailable.`).error }; let decision: import("./contracts.js").ToolAuthorizationDecision; try { decision = await this.awaitBoundary((this.authorization.policy ?? new AllowAllToolAuthorizationPolicy()).authorize(request)); } catch (error) { return { ok: false, error: this.boundaryError(error, "POLICY_VIOLATION", "Tool authorization failed.") }; } if (this.terminalCause) return { ok: false, error: this.terminalError() }; if (decision === "deny") return { ok: false, error: failure("AUTHORIZATION_DENIED", `Tool '${call.toolId}' was denied by policy.`).error }; if (decision === "require-approval") { if (!this.authorization.approvalProvider) return { ok: false, error: failure("POLICY_VIOLATION", "Tool approval is required but no approval provider is configured.").error }; try { const approval = await this.awaitBoundary(this.authorization.approvalProvider.approve({ ...request, approvalId: randomUUID() })); if (!approval.approved) return { ok: false, error: failure("AUTHORIZATION_DENIED", approval.reason ?? `Tool '${call.toolId}' was not approved.`).error }; } catch (error) { return { ok: false, error: this.boundaryError(error, "POLICY_VIOLATION", "Tool approval failed.") }; } if (this.terminalCause) return { ok: false, error: this.terminalError() }; } return this.tools.invoke(invocation, request.context); }
  private terminalError() { return failure(this.terminalCause === "timed-out" ? "TIMEOUT" : "CANCELLED", "Agent execution terminated.").error; }
  private async awaitBoundary<T>(promise: Promise<T>): Promise<T> { if (this.controller.signal.aborted) throw failure(this.terminalCause === "timed-out" ? "TIMEOUT" : "CANCELLED", "Agent execution terminated."); return new Promise<T>((resolve, reject) => { const onAbort = () => reject(failure(this.terminalCause === "timed-out" ? "TIMEOUT" : "CANCELLED", "Agent execution terminated.")); this.controller.signal.addEventListener("abort", onAbort, { once: true }); promise.then(resolve, reject).finally(() => this.controller.signal.removeEventListener("abort", onAbort)); }); }
  private boundaryError(error: unknown, code: "POLICY_VIOLATION", message: string) { if (error instanceof HarnessFailure && (error.error.code === "CANCELLED" || error.error.code === "TIMEOUT")) return error.error; return error instanceof HarnessFailure ? error.error : failure(code, error instanceof Error ? error.message : message).error; }
  private finishCause(): void { const cause = this.terminalCause!; if (cause === "cancelled") { this.push({ type: "cancelled" }); this.finish({ executionId: this.id, status: "cancelled" }); } else if (cause === "timed-out") { this.push({ type: "timed-out" }); this.finish({ executionId: this.id, status: "timed-out" }); } else { this.push({ type: "limit-reached" }); this.finish({ executionId: this.id, status: "limit-reached" }); } }
  private finish(result: AgentExecutionResult): void { if (this.terminal) return; if (result.status === "completed") this.queue.push({ type: "completed", text: result.text }); else if (result.status === "failed") this.queue.push({ type: "failed", error: result.error! }); this.terminal = true; this.resolveResult(result); this.queue.close(); }
  private push(event: AgentEvent): void { if (!this.terminal) this.queue.push(event); }
}
function freezeMessages(messages: readonly ModelMessage[]): readonly ModelMessage[] { return Object.freeze(messages.map((message) => freeze(message))); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; }
class AsyncQueue<T> implements AsyncIterable<T> { private readonly values: T[] = []; private waiter?: (result: IteratorResult<T>) => void; private closed = false; push(value: T) { if (this.closed) return; if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value, done: false }); } else this.values.push(value); } close() { this.closed = true; this.waiter?.({ value: undefined as T, done: true }); this.waiter = undefined; } [Symbol.asyncIterator]() { return { next: async () => this.values.length ? { value: this.values.shift()!, done: false } : this.closed ? { value: undefined as T, done: true } : new Promise<IteratorResult<T>>((resolve) => { this.waiter = resolve; }) }; } }
