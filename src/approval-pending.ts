import { ApprovalProvider, ApprovalRequestedEvent, ApprovalResolvedEvent, HarnessFailure, ToolApprovalDecision, ToolApprovalRequest, failure } from "./contracts.js";

export type PendingApprovalEvent = ApprovalRequestedEvent | ApprovalResolvedEvent;
export type ApprovalResolution = { decision: "approve" | "deny"; reason?: string };

export class PendingApprovalProvider implements ApprovalProvider {
  private readonly pending = new Map<string, { request: ToolApprovalRequest; resolve: (decision: ToolApprovalDecision) => void; reject: (error: HarnessFailure) => void }>();
  private readonly subscribers = new Set<AsyncQueue<PendingApprovalEvent>>();
  get pendingCount(): number { return this.pending.size; }
  async approve(request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    if (this.pending.has(request.approvalId)) throw failure("CAPABILITY_CONFLICT", `Approval '${request.approvalId}' is already pending.`);
    const promise = new Promise<ToolApprovalDecision>((resolve, reject) => { this.pending.set(request.approvalId, { request, resolve, reject }); });
    this.publish({ type: "ApprovalRequested", approvalId: request.approvalId, toolCallId: request.toolCallId, toolId: request.invocation.toolId, input: request.invocation.input, descriptor: request.descriptor, executionId: request.context.executionId, sessionId: request.context.sessionId, traceId: request.context.traceId });
    const onAbort = () => this.abort(request.approvalId, request.context.signal.aborted && request.context.deadline !== undefined && request.context.deadline <= Date.now() ? "TIMEOUT" : "CANCELLED");
    request.context.signal.addEventListener("abort", onAbort, { once: true });
    const timer = request.context.deadline === undefined ? undefined : setTimeout(() => this.abort(request.approvalId, "TIMEOUT"), Math.max(0, request.context.deadline - Date.now()));
    try { return await promise; } finally { request.context.signal.removeEventListener("abort", onAbort); if (timer !== undefined) clearTimeout(timer); }
  }
  resolve(approvalId: string, resolution: ApprovalResolution): ApprovalResolvedEvent {
    const entry = this.pending.get(approvalId); if (!entry) throw failure("CAPABILITY_UNAVAILABLE", `Approval '${approvalId}' is not pending.`);
    this.pending.delete(approvalId); const { request } = entry;
    const event: ApprovalResolvedEvent = { type: "ApprovalResolved", approvalId, decision: resolution.decision, executionId: request.context.executionId, sessionId: request.context.sessionId, traceId: request.context.traceId, ...(resolution.reason ? { reason: resolution.reason } : {}) };
    this.publish(event);
    entry.resolve({ approved: resolution.decision === "approve", ...(resolution.reason ? { reason: resolution.reason } : {}) });
    return event;
  }
  subscribe(): AsyncIterable<PendingApprovalEvent> { const queue = new AsyncQueue<PendingApprovalEvent>(); this.subscribers.add(queue); return new Subscription(queue, () => this.subscribers.delete(queue)); }
  private abort(approvalId: string, code: "CANCELLED" | "TIMEOUT") { const entry = this.pending.get(approvalId); if (!entry) return; this.pending.delete(approvalId); entry.reject(failure(code, code === "TIMEOUT" ? "Approval exceeded its deadline." : "Approval was cancelled.")); }
  private publish(event: PendingApprovalEvent) { for (const subscriber of this.subscribers) subscriber.push(event); }
}

class Subscription<T> implements AsyncIterable<T> {
  constructor(private readonly queue: AsyncQueue<T>, private readonly remove: () => void) {}
  [Symbol.asyncIterator]() { return { next: () => this.queue.next() }; }
  close() { this.remove(); this.queue.close(); }
}

class AsyncQueue<T> {
  private readonly values: T[] = []; private waiter?: (result: IteratorResult<T>) => void; private closed = false;
  push(value: T) { if (this.closed) return; if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value, done: false }); } else this.values.push(value); }
  close() { this.closed = true; this.waiter?.({ value: undefined as T, done: true }); this.waiter = undefined; }
  next(): Promise<IteratorResult<T>> { return this.values.length ? Promise.resolve({ value: this.values.shift()!, done: false }) : this.closed ? Promise.resolve({ value: undefined as T, done: true }) : new Promise((resolve) => { this.waiter = resolve; }); }
}
