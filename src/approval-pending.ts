import { ApprovalProvider, ApprovalRequestedEvent, ApprovalResolvedEvent, HarnessFailure, ToolApprovalDecision, ToolApprovalRequest, failure } from "./contracts.js";

export type ApprovalPendingRecord = ApprovalRequestedEvent;
export interface ApprovalPersistence { list(): readonly ApprovalPendingRecord[]; save(record: ApprovalPendingRecord): void; remove(approvalId: string): void }
export type ApprovalResolutionListener = (event: ApprovalResolvedEvent) => void | Promise<void>;
export type ApprovalCancellationListener = (sessionId: string) => void | Promise<void>;
export type PendingApprovalEvent = ApprovalRequestedEvent | ApprovalResolvedEvent;
export type ApprovalResolution = { decision: "approve" | "deny"; reason?: string };
interface PendingEntry { readonly event: ApprovalRequestedEvent; readonly request?: ToolApprovalRequest; readonly resolve?: (decision: ToolApprovalDecision) => void; readonly reject?: (error: HarnessFailure) => void }

export class PendingApprovalProvider implements ApprovalProvider {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly subscribers = new Set<AsyncQueue<PendingApprovalEvent>>(); private readonly cancellationListeners = new Set<ApprovalCancellationListener>(); private readonly resolutionListeners = new Set<ApprovalResolutionListener>();
  constructor(private readonly persistence?: ApprovalPersistence) { for (const record of persistence?.list() ?? []) if (!this.pending.has(record.approvalId)) this.pending.set(record.approvalId, { event: record }); }
  get pendingCount(): number { return this.pending.size; }
  onResolved(listener: ApprovalResolutionListener): () => void { this.resolutionListeners.add(listener); return () => this.resolutionListeners.delete(listener); }
  onCancelled(listener: ApprovalCancellationListener): () => void { this.cancellationListeners.add(listener); return () => this.cancellationListeners.delete(listener); }
  pendingRequests(): readonly ApprovalRequestedEvent[] { return [...this.pending.values()].map(({ event }) => event); }
  async approve(request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    if (this.pending.has(request.approvalId)) throw failure("CAPABILITY_CONFLICT", `Approval '${request.approvalId}' is already pending.`);
    const event: ApprovalRequestedEvent = { type: "ApprovalRequested", approvalId: request.approvalId, toolCallId: request.toolCallId, toolId: request.invocation.toolId, input: request.invocation.input, descriptor: request.descriptor, executionId: request.context.executionId, sessionId: request.context.sessionId, traceId: request.context.traceId };
    let resolvePromise!: (decision: ToolApprovalDecision) => void; let rejectPromise!: (error: HarnessFailure) => void;
    const promise = new Promise<ToolApprovalDecision>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    this.persistence?.save(event); this.pending.set(request.approvalId, { event, request, resolve: resolvePromise, reject: rejectPromise });
    this.publish(event);
    const onAbort = () => this.abort(request.approvalId, request.context.signal.aborted && request.context.deadline !== undefined && request.context.deadline <= Date.now() ? "TIMEOUT" : "CANCELLED");
    request.context.signal.addEventListener("abort", onAbort, { once: true });
    const timer = request.context.deadline === undefined ? undefined : setTimeout(() => this.abort(request.approvalId, "TIMEOUT"), Math.max(0, request.context.deadline - Date.now()));
    try { return await promise; } finally { request.context.signal.removeEventListener("abort", onAbort); if (timer !== undefined) clearTimeout(timer); }
  }
  cancelSession(sessionId: string): void { let cancelled = false; for (const [approvalId, entry] of this.pending) if (entry.event.sessionId === sessionId) { cancelled = true; this.abort(approvalId, "CANCELLED"); } if (cancelled) for (const listener of this.cancellationListeners) void listener(sessionId); }
  discard(approvalId: string): void { this.abort(approvalId, "CANCELLED"); }
  resolve(approvalId: string, resolution: ApprovalResolution): ApprovalResolvedEvent {
    const entry = this.pending.get(approvalId); if (!entry) throw failure("CAPABILITY_UNAVAILABLE", `Approval '${approvalId}' is not pending.`);
    this.pending.delete(approvalId); this.persistence?.remove(approvalId);
    const { event } = entry; const resolved: ApprovalResolvedEvent = { type: "ApprovalResolved", approvalId, decision: resolution.decision, executionId: event.executionId, sessionId: event.sessionId, traceId: event.traceId, ...(resolution.reason ? { reason: resolution.reason } : {}) };
    this.publish(resolved); for (const listener of this.resolutionListeners) void listener(resolved); entry.resolve?.({ approved: resolution.decision === "approve", ...(resolution.reason ? { reason: resolution.reason } : {}) }); return resolved;
  }
  subscribe(): AsyncIterable<PendingApprovalEvent> { const queue = new AsyncQueue<PendingApprovalEvent>(); this.subscribers.add(queue); return new Subscription(queue, () => this.subscribers.delete(queue)); }
  private abort(approvalId: string, code: "CANCELLED" | "TIMEOUT") { const entry = this.pending.get(approvalId); if (!entry) return; this.pending.delete(approvalId); this.persistence?.remove(approvalId); entry.reject?.(failure(code, code === "TIMEOUT" ? "Approval exceeded its deadline." : "Approval was cancelled.")); }
  private publish(event: PendingApprovalEvent) { for (const subscriber of this.subscribers) subscriber.push(event); }
}

class Subscription<T> implements AsyncIterable<T> { constructor(private readonly queue: AsyncQueue<T>, private readonly remove: () => void) {} [Symbol.asyncIterator]() { return { next: () => this.queue.next() }; } close() { this.remove(); this.queue.close(); } }
class AsyncQueue<T> { private readonly values: T[] = []; private waiter?: (result: IteratorResult<T>) => void; private closed = false; push(value: T) { if (this.closed) return; if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value, done: false }); } else this.values.push(value); } close() { this.closed = true; this.waiter?.({ value: undefined as T, done: true }); this.waiter = undefined; } next(): Promise<IteratorResult<T>> { return this.values.length ? Promise.resolve({ value: this.values.shift()!, done: false }) : this.closed ? Promise.resolve({ value: undefined as T, done: true }) : new Promise((resolve) => { this.waiter = resolve; }); } }
