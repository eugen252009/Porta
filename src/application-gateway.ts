import { randomUUID } from "node:crypto";
import { AgentEvent, AgentExecution, AgentOrchestrator } from "./agent.js";
import { PendingApprovalEvent, PendingApprovalProvider } from "./approval-pending.js";
import { ApplicationGateway, CommandContext, ConversationStore, KernelCommand, KernelEvent, ModelContext, ModelProvider, ToolAuthorizationPolicy, failure, resolveApprovalCommandSchema } from "./contracts.js";
import { MemoryConversationStore, sessionFromBase } from "./conversation.js";
import { ToolRouter } from "./tools.js";

export class InteractiveApprovalGateway implements ApplicationGateway {
  private readonly active = new Map<string, AgentExecution>();
  constructor(private readonly model: ModelProvider, private readonly tools: ToolRouter, private readonly pending: PendingApprovalProvider, private readonly policy: ToolAuthorizationPolicy, private readonly limits = { maxSteps: 8, maxToolCalls: 16 }, private readonly conversations: ConversationStore = new MemoryConversationStore()) {}
  async *execute(command: KernelCommand, context: CommandContext = {}): AsyncIterable<KernelEvent> {
    if (command.type === "CreateSession") {
      const sessionId = randomUUID();
      await this.conversations.createSession(sessionFromBase({ schemaVersion: 1, id: sessionId, state: "open", createdAt: new Date().toISOString() }));
      yield { type: "SessionCreated", sessionId }; return;
    }
    if (command.type === "ResolveApproval") {
      const parsed = resolveApprovalCommandSchema.safeParse(command);
      if (!parsed.success) { yield { type: "Error", error: failure("VALIDATION_FAILED", "Approval resolution command is invalid.", false, { issues: parsed.error.issues }).error }; return; }
      try { yield this.pending.resolve(command.approvalId, { decision: command.decision, ...(command.reason ? { reason: command.reason } : {}) }); }
      catch (error) { yield { type: "Error", error: error instanceof Error && "error" in error ? (error as { error: import("./contracts.js").HarnessError }).error : failure("CAPABILITY_UNAVAILABLE", error instanceof Error ? error.message : "Approval is unavailable.").error }; }
      return;
    }
    const session = await this.conversations.getSession(command.sessionId);
    if (!session || session.state !== "open") { yield { type: "Error", error: failure("STORAGE_FAILED", `Session '${command.sessionId}' is unavailable.`).error }; return; }
    if (command.type === "CloseSession") { await this.conversations.closeSession(command.sessionId); yield { type: "SessionClosed", sessionId: command.sessionId }; return; }
    if (command.type === "CancelExecution") { await this.active.get(command.sessionId)?.cancel(); return; }
    if (this.active.has(command.sessionId)) { yield { type: "Error", error: failure("CAPABILITY_CONFLICT", `Session '${command.sessionId}' already has an active execution.`).error }; return; }

    const snapshot = await this.conversations.snapshot(command.sessionId);
    const gatewayExecutionId = randomUUID();
    const controller = new AbortController();
    if (context.signal) context.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const modelContext: ModelContext = { traceId: context.traceId ?? randomUUID(), sessionId: command.sessionId, executionId: gatewayExecutionId, signal: controller.signal, deadline: context.deadline };
    const approvalEvents = this.pending.subscribe();
    const execution = new AgentOrchestrator(this.model, this.tools, this.limits, { policy: this.policy, approvalProvider: this.pending }).create(command.input, modelContext, this.tools.listTools(), snapshot.history);
    const executionId = execution.id;
    this.active.set(command.sessionId, execution);
    yield { type: "ExecutionStarted", executionId };
    const merged = new AsyncQueue<{ kind: "agent" | "approval"; event: AgentEvent | PendingApprovalEvent }>();
    const pump = async <T>(source: AsyncIterable<T>, kind: "agent" | "approval") => { for await (const event of source) merged.push({ kind, event: event as AgentEvent | PendingApprovalEvent }); };
    void Promise.all([pump(execution.events(), "agent"), pump(approvalEvents, "approval")]).finally(() => merged.close());
    try {
      for (;;) {
        const item = await merged.next(); if (item.done) break;
        if (item.value.kind === "approval") { const event = item.value.event as PendingApprovalEvent; if (event.executionId === executionId) yield event; continue; }
        const event = item.value.event as AgentEvent; const mapped = mapAgentEvent(event); if (mapped) yield mapped;
        if (["completed", "failed", "cancelled", "timed-out", "limit-reached"].includes(event.type)) break;
      }
      const result = await execution.result();
      if (result.status === "completed" && result.messages?.length) await this.conversations.commitTurn(command.sessionId, { messages: result.messages });
    } finally {
      this.active.delete(command.sessionId);
      const subscription = approvalEvents as unknown as { close?: () => void }; subscription.close?.();
    }
  }
  async shutdown(): Promise<void> { await Promise.all([...this.active.values()].map((execution) => execution.cancel())); this.active.clear(); for (const id of this.conversations.openSessionIds()) await this.conversations.closeSession(id); }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []; private waiter?: (result: IteratorResult<T>) => void; private closed = false;
  push(value: T) { if (this.closed) return; if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value, done: false }); } else this.values.push(value); }
  next(): Promise<IteratorResult<T>> { return this.values.length ? Promise.resolve({ value: this.values.shift()!, done: false }) : this.closed ? Promise.resolve({ value: undefined as T, done: true }) : new Promise((resolve) => { this.waiter = resolve; }); }
  close() { this.closed = true; this.waiter?.({ value: undefined as T, done: true }); this.waiter = undefined; }
  [Symbol.asyncIterator]() { return { next: async () => this.values.length ? { value: this.values.shift()!, done: false } : this.closed ? { value: undefined as T, done: true } : new Promise<IteratorResult<T>>((resolve) => { this.waiter = resolve; }) }; }
}

function mapAgentEvent(event: AgentEvent): KernelEvent | undefined {
  if (event.type === "started") return { type: "OutputStarted" };
  if (event.type === "tool-requested") return { type: "ToolRequested", toolCallId: event.toolCallId, toolId: event.toolId };
  if (event.type === "tool-started") return { type: "ToolStarted", toolCallId: event.toolCallId, toolId: event.toolId };
  if (event.type === "tool-completed") return { type: "ToolCompleted", toolCallId: event.toolCallId, toolId: event.toolId, result: event.result };
  if (event.type === "model-text") return { type: "OutputDelta", text: event.text };
  if (event.type === "completed") return { type: "ExecutionCompleted" };
  if (event.type === "cancelled" || event.type === "timed-out") return { type: "ExecutionCancelled" };
  if (event.type === "failed") return { type: "Error", error: event.error };
  return undefined;
}
