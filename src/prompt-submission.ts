import { JobRunner, MemoryJobStore } from "./jobs.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ApplicationGateway, ExecutionMode, ModelSelection } from "./contracts.js";
import type { Principal } from "./node-delegation.js";
import type { TargetRegistry } from "./target.js";
import type { ConversationStore } from "./contracts.js";
import { RemoteApplicationError, type RemoteApplicationGateway } from "./remote-application.js";
import type { ApplicationEventHub } from "./application-events.js";

export interface PromptSubmitRequest { readonly content: string; readonly targetNodeId?: string; readonly sessionId?: string; readonly requestedModel?: ModelSelection; readonly mode?: ExecutionMode; readonly idempotencyKey: string; readonly source?: string }
export interface PromptSubmitResult { readonly nodeId: string; readonly sessionId: string; readonly status: "accepted"; readonly jobId?: string; readonly durable?: boolean }
export class PromptSubmissionError extends Error { constructor(readonly kind: "unavailable" | "denied" | "unsupported" | "not_found" | "failed", message: string, readonly cause?: unknown) { super(message); this.name = "PromptSubmissionError"; } }
interface PromptSubmissionContext { readonly nodeId: string; readonly gateway: ApplicationGateway; readonly conversations: ConversationStore; readonly executionTargets: TargetRegistry; resolveModel(requested?: string): Promise<import("./contracts.js").ModelProvider>; readonly events: ApplicationEventHub; readonly jobs?: JobRunner; readonly durable?: boolean; readonly defaultModel?: ModelSelection }

/** Canonical application operation used by Web and external clients to create normal Porta work. */
export class PromptSubmissionService {
  private readonly idempotent = new Map<string, PromptSubmitResult>();
  private readonly inFlight = new Map<string, Promise<PromptSubmitResult>>();
  readonly jobs: JobRunner;
  constructor(private readonly context: PromptSubmissionContext, private readonly persistencePath?: string) { this.jobs = context.jobs ?? new JobRunner(new MemoryJobStore(), context.gateway); if (persistencePath && existsSync(persistencePath)) { const stored = JSON.parse(readFileSync(persistencePath, "utf8")) as Record<string, PromptSubmitResult>; for (const [key, value] of Object.entries(stored)) this.idempotent.set(key, value); } }
  async submit(request: PromptSubmitRequest, principal: Principal): Promise<PromptSubmitResult> {
    if (principal.kind === "integration" && !principal.permissions.includes("prompt.submit")) throw new PromptSubmissionError("denied", "Prompt submission permission is required.");
    const key = JSON.stringify([principal.identity, request.targetNodeId || "local", request.idempotencyKey]);
    const active = this.inFlight.get(key); if (active) return active;
    const pending = this.submitOnce(request, principal); this.inFlight.set(key, pending);
    try { return await pending; } finally { this.inFlight.delete(key); }
  }
  private async submitOnce(request: PromptSubmitRequest, principal: Principal): Promise<PromptSubmitResult> {
    if (typeof request.content !== "string" || typeof request.idempotencyKey !== "string" || Buffer.byteLength(request.content) > 512 * 1024 || request.idempotencyKey.length > 128) throw new PromptSubmissionError("failed", "Invalid prompt or idempotency key.");
    if (!request.content.trim() || !request.idempotencyKey.trim()) throw new PromptSubmissionError("failed", "Prompt content and idempotencyKey are required.");
    const mode = request.mode ?? "chat";
    const targetNodeId = request.targetNodeId || "local"; const key = `${principal.identity}:${targetNodeId}:${request.idempotencyKey}`; const stored = this.jobs.store.byKey(JSON.stringify([principal.identity, targetNodeId, request.idempotencyKey])); if (stored) return { nodeId: stored.nodeId, sessionId: stored.sessionId, jobId: stored.id, status: "accepted", durable: this.context.durable ?? false }; const existing = this.idempotent.get(key); if (existing) return existing;
    const model = request.requestedModel;
    if (targetNodeId === "local") {
      if (model && !request.sessionId) await this.context.resolveModel(`${model.provider}/${model.model}`);
      if (request.sessionId) {
        const existing = await this.context.conversations.getSession(request.sessionId);
        if (!existing || existing.state !== "open") throw new PromptSubmissionError("not_found", `Session '${request.sessionId}' is unavailable.`);
        if (existing.target && existing.target !== "local") throw new PromptSubmissionError("denied", `Session '${request.sessionId}' does not belong to target 'local'.`);
      }
      const selectedModel = model ?? this.context.defaultModel;
      const events = await collect(this.context.gateway.execute({ type: "CreateSession", ...(request.sessionId ? { sessionId: request.sessionId } : { target: "local", ...(selectedModel ? { model: selectedModel } : {}) }) }, {})); const created = events.find((event): event is Extract<import("./contracts.js").KernelEvent, { type: "SessionCreated" }> => event.type === "SessionCreated"); if (!created) throw new PromptSubmissionError("failed", "Porta could not create or resume a session.");
      const sessionModel = (await this.context.conversations.getSession(created.sessionId))?.model ?? selectedModel;
      const historyBaseMessageCount = (await this.context.conversations.snapshot(created.sessionId)).history.length;
      const job = this.jobs.accept({ key: JSON.stringify([principal.identity, targetNodeId, request.idempotencyKey]), nodeId: this.context.nodeId, sessionId: created.sessionId, input: request.content, mode, historyBaseMessageCount, ...(sessionModel ? { model: sessionModel } : {}) });
      const result = { nodeId: job.nodeId, sessionId: job.sessionId, jobId: job.id, status: "accepted" as const, durable: this.context.durable ?? false };
      this.context.events.publish({ type: request.sessionId ? "session.updated" : "session.created", nodeId: result.nodeId, sessionId: result.sessionId }); return result;
    }
    const target = this.context.executionTargets.resolve(targetNodeId); const remote = target?.application as RemoteApplicationGateway | undefined; if (!target || !remote) throw new PromptSubmissionError("unsupported", `Target '${targetNodeId}' does not expose prompt submission.`);
    try { const session = await remote.createSession(request.sessionId ? { sessionId: request.sessionId } : (model ? { model } : {})); const result = { nodeId: targetNodeId, sessionId: session.id, status: "accepted" as const }; this.idempotent.set(key, result); this.persist(); this.context.events.publish({ type: request.sessionId ? "session.updated" : "session.created", nodeId: targetNodeId, sessionId: session.id }); void remote.submitSession(session.id, request.content).catch(() => undefined); return result; }
    catch (error) { if (error instanceof RemoteApplicationError) throw new PromptSubmissionError(error.kind === "unsupported" && request.sessionId ? "not_found" : error.kind, error.message, error); throw new PromptSubmissionError("failed", error instanceof Error ? error.message : "Remote prompt submission failed.", error); }
  }
  private persist(): void { if (this.persistencePath) writeFileSync(this.persistencePath, JSON.stringify(Object.fromEntries(this.idempotent), null, 2) + "\n", { mode: 0o600 }); }
}
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }
