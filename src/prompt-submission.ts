import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ApplicationGateway, ModelSelection } from "./contracts.js";
import type { Principal } from "./node-delegation.js";
import type { TargetRegistry } from "./target.js";
import type { ConversationStore } from "./contracts.js";
import { RemoteApplicationError, type RemoteApplicationGateway } from "./remote-application.js";
import type { ApplicationEventHub } from "./application-events.js";

export interface PromptSubmitRequest { readonly content: string; readonly targetNodeId?: string; readonly requestedModel?: ModelSelection; readonly mode?: "session" | "task"; readonly idempotencyKey: string; readonly source?: string }
export interface PromptSubmitResult { readonly nodeId: string; readonly sessionId: string; readonly status: "accepted" }
export class PromptSubmissionError extends Error { constructor(readonly kind: "unavailable" | "denied" | "unsupported" | "failed", message: string, readonly cause?: unknown) { super(message); this.name = "PromptSubmissionError"; } }
interface PromptSubmissionContext { readonly nodeId: string; readonly gateway: ApplicationGateway; readonly conversations: ConversationStore; readonly executionTargets: TargetRegistry; resolveModel(requested?: string): Promise<import("./contracts.js").ModelProvider>; readonly events: ApplicationEventHub }

/** Canonical application operation used by Web and external clients to create normal Porta work. */
export class PromptSubmissionService {
  private readonly idempotent = new Map<string, PromptSubmitResult>();
  constructor(private readonly context: PromptSubmissionContext, private readonly persistencePath?: string) { if (persistencePath && existsSync(persistencePath)) { const stored = JSON.parse(readFileSync(persistencePath, "utf8")) as Record<string, PromptSubmitResult>; for (const [key, value] of Object.entries(stored)) this.idempotent.set(key, value); } }
  async submit(request: PromptSubmitRequest, principal: Principal): Promise<PromptSubmitResult> {
    if (!request.content.trim() || !request.idempotencyKey.trim()) throw new PromptSubmissionError("failed", "Prompt content and idempotencyKey are required.");
    if (request.mode === "task") throw new PromptSubmissionError("unsupported", "Task-mode prompt submission is not available; use session mode.");
    const targetNodeId = request.targetNodeId || "local"; const key = `${principal.identity}:${targetNodeId}:${request.idempotencyKey}`; const existing = this.idempotent.get(key); if (existing) return existing;
    const model = request.requestedModel;
    if (targetNodeId === "local") {
      if (model) await this.context.resolveModel(`${model.provider}/${model.model}`);
      const events = await collect(this.context.gateway.execute({ type: "CreateSession", target: "local", ...(model ? { model } : {}) }, {})); const created = events.find((event): event is Extract<import("./contracts.js").KernelEvent, { type: "SessionCreated" }> => event.type === "SessionCreated"); if (!created) throw new PromptSubmissionError("failed", "Porta could not create a session.");
      const result = { nodeId: this.context.nodeId, sessionId: created.sessionId, status: "accepted" as const }; this.idempotent.set(key, result); this.persist(); this.context.events.publish({ type: "session.created", nodeId: result.nodeId, sessionId: result.sessionId }); void collect(this.context.gateway.execute({ type: "SubmitInput", sessionId: result.sessionId, input: request.content }, {})).catch(() => undefined); return result;
    }
    const target = this.context.executionTargets.resolve(targetNodeId); const remote = target?.application as RemoteApplicationGateway | undefined; if (!target || !remote) throw new PromptSubmissionError("unsupported", `Target '${targetNodeId}' does not expose prompt submission.`);
    try { const session = await remote.createSession(model ? { model } : {}); const result = { nodeId: targetNodeId, sessionId: session.id, status: "accepted" as const }; this.idempotent.set(key, result); this.persist(); this.context.events.publish({ type: "session.created", nodeId: targetNodeId, sessionId: session.id }); void remote.submitSession(session.id, request.content).catch(() => undefined); return result; }
    catch (error) { if (error instanceof RemoteApplicationError) throw new PromptSubmissionError(error.kind, error.message, error); throw new PromptSubmissionError("failed", error instanceof Error ? error.message : "Remote prompt submission failed.", error); }
  }
  private persist(): void { if (this.persistencePath) writeFileSync(this.persistencePath, JSON.stringify(Object.fromEntries(this.idempotent), null, 2) + "\n", { mode: 0o600 }); }
}
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }
