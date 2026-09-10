import { randomUUID } from "node:crypto";
import { AgentEvent, AgentExecution, AgentOrchestrator } from "./agent.js";
import { AllowAllToolAuthorizationPolicy } from "./authorization-mocks.js";
import { PendingApprovalEvent, PendingApprovalProvider } from "./approval-pending.js";
import { ApplicationGateway, CommandContext, ConversationStore, ConversationSnapshot, KernelCommand, KernelEvent, ModelContext, ModelProvider, ModelSelection, ToolAuthorizationPolicy, ToolDescriptor, failure, HarnessFailure, resolveApprovalCommandSchema } from "./contracts.js";
import { MemoryConversationStore, sessionFromBase } from "./conversation.js";
import { ConversationCompactor, DeterministicConversationCompactor } from "./compaction.js";
import { ScratchpadStore } from "./scratchpad.js";
import { TaskStore, taskSnapshot } from "./task.js";
import { ToolRouter } from "./tools.js";
import type { DurableExecution, ExecutionPersistence } from "./execution-persistence.js";
import { recoveryDecision } from "./execution-recovery.js";

export interface ConversationContextOptions { enabled?: boolean; threshold?: number; keepRecentTurns?: number; maxManifestEntries?: number; maxSummaryChars?: number; compactor?: ConversationCompactor; scratchpad?: ScratchpadStore; taskStore?: TaskStore }
export class InteractiveApprovalGateway implements ApplicationGateway {
  private readonly active = new Map<string, AgentExecution>();
  private readonly sessionModels = new Map<string, ModelProvider>(); private readonly recovered = new Set<string>(); private readonly executionSessions = new Map<string, string>(); private readonly executionInputs = new Map<string, { input: string; history: readonly import("./contracts.js").ModelMessage[] }>();
  constructor(private readonly model: ModelProvider, private readonly tools: ToolRouter, private readonly pending: PendingApprovalProvider, private readonly policy: ToolAuthorizationPolicy, private readonly limits = { maxSteps: 8, maxToolCalls: 16 }, private readonly conversations: ConversationStore = new MemoryConversationStore(), private readonly contextOptions: ConversationContextOptions = {}, private readonly modelForSession?: (selection: ModelSelection) => ModelProvider | Promise<ModelProvider>, private readonly executions?: ExecutionPersistence) { this.pending.onResolved((event) => this.onApprovalResolved(event)); this.pending.onCancelled((sessionId) => this.onApprovalCancelled(sessionId)); for (const state of executions?.listIncomplete() ?? []) if (recoveryDecision(state).action === "wait_for_approval") this.recovered.add(state.executionId); }
  async *execute(command: KernelCommand, context: CommandContext = {}): AsyncIterable<KernelEvent> {
    if (command.type === "CreateSession") {
      const sessionId = command.sessionId ?? randomUUID();
      const existing = command.sessionId ? await this.conversations.getSession(command.sessionId) : undefined;
      if (command.sessionId && (!existing || existing.state !== "open")) { yield { type: "Error", error: failure("STORAGE_FAILED", `Session '${command.sessionId}' is unavailable.`).error }; return; }
      if (!existing) await this.conversations.createSession(sessionFromBase({ schemaVersion: 1, id: sessionId, state: "open", createdAt: new Date().toISOString(), ...(command.target ? { target: command.target } : {}), ...(command.model ? { model: command.model } : {}) }));
      if (command.model && !existing && this.modelForSession) {
        try {
          const selectedModel = await this.modelForSession(command.model);
          if ("health" in selectedModel && typeof selectedModel.health === "function") { const health = await selectedModel.health(); if (health.status !== "healthy") { await this.conversations.closeSession(sessionId); yield { type: "Error", error: failure("CAPABILITY_UNAVAILABLE", health.message ?? "Selected model provider is unavailable.").error }; return; } }
          this.sessionModels.set(sessionId, selectedModel);
        } catch (error) { yield { type: "Error", error: normalizeError(error) }; return; }
      }
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
    if (command.type === "CloseSession") { await this.conversations.closeSession(command.sessionId); this.sessionModels.delete(command.sessionId); yield { type: "SessionClosed", sessionId: command.sessionId }; return; }
    if (command.type === "CancelExecution") { await this.active.get(command.sessionId)?.cancel(); return; }
    if (this.active.has(command.sessionId)) { yield { type: "Error", error: failure("CAPABILITY_CONFLICT", `Session '${command.sessionId}' already has an active execution.`).error }; return; }

    const gatewayExecutionId = randomUUID();
    const controller = new AbortController();
    if (context.signal?.aborted) controller.abort(); else if (context.signal) context.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const modelContext: ModelContext = { traceId: context.traceId ?? randomUUID(), sessionId: command.sessionId, executionId: gatewayExecutionId, signal: controller.signal, deadline: context.deadline };
    let prepared: { history: readonly import("./contracts.js").ModelMessage[]; control: readonly import("./contracts.js").ModelControlMessage[] };
    try { prepared = await this.prepareContext(command.sessionId, modelContext); }
    catch (error) { yield { type: "Error", error: normalizeError(error) }; return; }
    const approvalEvents = this.pending.subscribe();
    const execution = new AgentOrchestrator(this.sessionModels.get(command.sessionId) ?? this.model, this.tools, this.limits, { policy: this.policy, approvalProvider: this.pending }).create(command.input, modelContext, modelFacingDescriptors(this.tools), prepared.history, prepared.control, gatewayExecutionId);
    const executionId = execution.id;
    this.active.set(command.sessionId, execution); this.executionSessions.set(executionId, command.sessionId); this.executionInputs.set(executionId, { input: command.input, history: prepared.history });
    yield { type: "ExecutionStarted", executionId };
    const merged = new AsyncQueue<{ kind: "agent" | "approval"; event: AgentEvent | PendingApprovalEvent }>();
    const pump = async <T>(source: AsyncIterable<T>, kind: "agent" | "approval") => { for await (const event of source) merged.push({ kind, event: event as AgentEvent | PendingApprovalEvent }); };
    void Promise.all([pump(execution.events(), "agent"), pump(approvalEvents, "approval")]).finally(() => merged.close());
    try {
      for (;;) {
        const item = await merged.next(); if (item.done) break;
        if (item.value.kind === "approval") { const event = item.value.event as PendingApprovalEvent; if (event.type === "ApprovalRequested" && event.executionId === executionId) this.checkpointApproval(executionId, event.approvalId); if (event.executionId === executionId) yield event; continue; }
        const event = item.value.event as AgentEvent; this.checkpointAgentEvent(executionId, event); const mapped = mapAgentEvent(event); if (mapped) yield mapped;
        if (["completed", "failed", "cancelled", "timed-out", "limit-reached"].includes(event.type)) break;
      }
      const result = await execution.result();
      if (result.status === "completed" && result.messages?.length) await this.conversations.commitTurn(command.sessionId, { messages: result.messages });
    } finally {
      this.active.delete(command.sessionId); this.executionSessions.delete(executionId); this.executionInputs.delete(executionId);
      const subscription = approvalEvents as unknown as { close?: () => void }; subscription.close?.();
    }
  }
  hasActiveExecution(sessionId: string): boolean { return this.active.has(sessionId); }
  async recoverPendingExecutions(): Promise<void> { for (const state of this.executions?.listIncomplete() ?? []) if (recoveryDecision(state).action === "wait_for_approval" && state.approvalId && this.pending.pendingRequests().some((approval) => approval.approvalId === state.approvalId)) this.recovered.add(state.executionId); }
  private checkpointAgentEvent(executionId: string, event: AgentEvent): void { if (!this.executions || event.type !== "tool-requested") return; const sessionId = this.executionSessions.get(executionId); if (!sessionId) return; const now = new Date().toISOString(); const current = this.executions.get(executionId); const next: DurableExecution = { executionId, sessionId, traceId: executionId, phase: "model_completed", version: (current?.version ?? 0) + 1, input: this.executionInputs.get(executionId)?.input ?? "", history: this.executionInputs.get(executionId)?.history ?? [], currentToolCall: { id: event.toolCallId, toolId: event.toolId, input: event.input }, modelOutput: { toolCalls: [{ id: event.toolCallId, toolId: event.toolId, input: event.input }] }, createdAt: current?.createdAt ?? now, updatedAt: now }; try { this.executions.save(next, current?.version); } catch { /* the live execution remains authoritative; a stale checkpoint cannot execute a tool */ } }
  private checkpointApproval(executionId: string, approvalId: string): void { const current = this.executions?.get(executionId); if (!current) return; try { this.executions!.save({ ...current, phase: "approval_required", approvalId, version: current.version + 1, updatedAt: new Date().toISOString() }, current.version); } catch { /* CAS protects against duplicate recovery */ } }
  private async onApprovalCancelled(sessionId: string): Promise<void> { for (const state of this.executions?.listIncomplete() ?? []) if (state.sessionId === sessionId && state.phase === "approval_required") try { this.executions!.save({ ...state, phase: "cancelled", version: state.version + 1, updatedAt: new Date().toISOString() }, state.version); } catch {} }
  private async onApprovalResolved(event: import("./contracts.js").ApprovalResolvedEvent): Promise<void> { const current = this.executions?.get(event.executionId); if (!current || current.phase !== "approval_required") return; const now = new Date().toISOString(); const phase = event.decision === "approve" ? "tool_authorized" : "failed"; try { this.executions!.save({ ...current, phase, version: current.version + 1, ...(event.decision === "approve" ? {} : { failure: event.reason ?? "Approval denied." }), updatedAt: now }, current.version); } catch { return; } if (event.decision === "approve" && !this.active.has(current.sessionId) && this.recovered.has(current.executionId)) { this.recovered.delete(current.executionId); await this.resumeRecovered({ ...current, phase: "tool_authorized", version: current.version + 1, updatedAt: now }); } }
  private async resumeRecovered(state: DurableExecution): Promise<void> { if (!state.currentToolCall || !this.executions) return; if (this.active.has(state.sessionId)) return; const context: ModelContext = { traceId: state.traceId, sessionId: state.sessionId, executionId: state.executionId, signal: new AbortController().signal }; const execution = new AgentOrchestrator(this.model, this.tools, this.limits, { policy: new AllowAllToolAuthorizationPolicy() }).createRecovered(state, context, modelFacingDescriptors(this.tools)); this.active.set(state.sessionId, execution); try { for await (const event of execution.events()) this.checkpointRecoveredEvent(state, event); const result = await execution.result(); if (result.status === "completed" && result.messages?.length) await this.conversations.commitTurn(state.sessionId, { messages: result.messages }); const current = this.executions.get(state.executionId); if (current) this.executions.save({ ...current, phase: result.status === "completed" ? "completed" : "failed", version: current.version + 1, updatedAt: new Date().toISOString(), ...(result.error ? { failure: result.error.message } : {}) }, current.version); } finally { this.active.delete(state.sessionId); } }
  private checkpointRecoveredEvent(state: DurableExecution, event: AgentEvent): void { if (!this.executions) return; const current = this.executions.get(state.executionId); if (!current) return; const now = new Date().toISOString(); if (event.type === "tool-started") { const tool = { toolExecutionId: `${state.executionId}:${event.toolCallId}`, executionId: state.executionId, toolCallId: event.toolCallId, toolId: event.toolId, input: current.currentToolCall?.input ?? null, state: "prepared" as const, retrySafe: true, createdAt: now, updatedAt: now }; try { this.executions.save({ ...current, phase: "tool_running", tool, version: current.version + 1, updatedAt: now }, current.version); } catch {} } else if (event.type === "tool-completed") { try { this.executions.save({ ...current, phase: "continuation_pending", tool: current.tool ? { ...current.tool, state: "succeeded", result: event.result, updatedAt: now } : undefined, version: current.version + 1, updatedAt: now }, current.version); } catch {} } }

  async shutdown(): Promise<void> { await Promise.all([...this.active.values()].map((execution) => execution.cancel())); this.active.clear(); }
  private async prepareContext(sessionId: string, context: ModelContext): Promise<{ history: readonly import("./contracts.js").ModelMessage[]; control: readonly import("./contracts.js").ModelControlMessage[] }> {
    const snapshot = await this.conversations.snapshot(sessionId); const threshold = this.contextOptions.threshold;
    const taskControl = await this.taskControl(sessionId);
    if (!this.contextOptions.enabled || threshold === undefined || snapshot.turns.length <= threshold) return { history: snapshot.history, control: taskControl };
    const keep = Math.min(this.contextOptions.keepRecentTurns ?? 4, threshold); const oldTurns = snapshot.turns.slice(0, Math.max(0, snapshot.turns.length - keep)); const recent = snapshot.turns.slice(-keep);
    if (!oldTurns.length) return { history: recent.flatMap((turn) => turn.messages), control: taskControl };
    let summary: string;
    try { const compactor = this.contextOptions.compactor ?? new DeterministicConversationCompactor(); summary = (await compactor.compact({ turns: oldTurns, compactedThrough: snapshot.turns.length - keep, maxChars: this.contextOptions.maxSummaryChars }, context)).summary; }
    catch (error) { if (isCancellation(error, context)) throw error; return { history: recent.flatMap((turn) => turn.messages), control: taskControl }; }
    const control: import("./contracts.js").ModelControlMessage[] = [{ role: "system", content: `Conversation history was compacted.\n\nCompacted summary:\n${summary}` }, { role: "system", content: "Relevant working notes may exist in the scratchpad. Use scratchpad/search or scratchpad/list to locate relevant notes, and scratchpad/read only the entries you need before making assumptions." }];
    if (this.contextOptions.scratchpad) { const entries = await this.contextOptions.scratchpad.list(sessionId); const limit = this.contextOptions.maxManifestEntries ?? 20; const shown = entries.slice(0, limit); const suffix = entries.length > limit ? `\n... ${entries.length - limit} more entries available via scratchpad/list` : ""; control.push({ role: "system", content: `Available scratchpad entries:\n${shown.map((entry) => `- ${entry.key} (${entry.bytes} bytes)`).join("\n") || "- none"}${suffix}` }); }
    if (taskControl.length) control.push(...taskControl);
    return { history: recent.flatMap((turn) => turn.messages), control };
  }
  private async taskControl(sessionId: string): Promise<readonly import("./contracts.js").ModelControlMessage[]> { const task = await this.contextOptions.taskStore?.get(sessionId); return task ? [{ role: "system", content: taskSnapshot(task) }] : []; }
}
/** Models address tools by their provider-scoped canonical identity: the router routes by that identity and bare local ids may collide across providers. */
function modelFacingDescriptors(router: ToolRouter): readonly ToolDescriptor[] { return router.listTools().map((tool) => ({ ...tool, id: tool.canonicalId })); }
function isCancellation(error: unknown, context: ModelContext): boolean { return context.signal.aborted || (error instanceof HarnessFailure && (error.error.code === "CANCELLED" || error.error.code === "TIMEOUT")); }
function normalizeError(error: unknown): import("./contracts.js").HarnessError { if (error instanceof HarnessFailure) return error.error; return failure("MODEL_FAILED", error instanceof Error ? error.message : "Conversation context preparation failed.").error; }

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
