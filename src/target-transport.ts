import { randomUUID } from "node:crypto";
import type { ExecutionTargetCapability } from "./target.js";

export type TargetOperation = "filesystem.read" | "filesystem.write" | "filesystem.delete" | "execution.run";
export interface TargetDescription { readonly id: string; readonly kind: string; readonly available: boolean; readonly capabilities: readonly ExecutionTargetCapability[]; readonly workspace?: { readonly id: string; readonly path: string; readonly repository?: string }; readonly platform?: string }
export interface TargetOperationRequest { readonly requestId: string; readonly targetId: string; readonly workspaceId: string; readonly operation: TargetOperation; readonly input: unknown; readonly deadline?: number }
export interface TargetOperationResult { readonly requestId: string; readonly targetId: string; readonly operation: TargetOperation; readonly status: "completed" | "failed" | "cancelled" | "timed-out"; readonly output?: unknown; readonly error?: { readonly code: string; readonly message: string }; readonly startedAt: string; readonly finishedAt: string }
export interface TargetTransport { describe(signal?: AbortSignal): Promise<TargetDescription>; invoke(request: TargetOperationRequest, signal?: AbortSignal): Promise<TargetOperationResult>; cancel(requestId: string): Promise<void> }

export interface TargetAuthenticator { authenticate(targetId: string, challenge: string, signature: string): Promise<boolean> }
export interface TargetAuthenticationProof { readonly targetId: string; readonly challenge: string; readonly identity: string; readonly signature: string }

/** Client-side authenticated transport seam. The transport implementation owns the wire protocol. */
export class AuthenticatedTargetTransport implements TargetTransport {
  private authenticated = false;
  constructor(private readonly transport: TargetTransport, private readonly proof: TargetAuthenticationProof, private readonly authenticate: (proof: TargetAuthenticationProof) => Promise<boolean>) {}
  async describe(signal?: AbortSignal): Promise<TargetDescription> { await this.ensureAuthenticated(); return this.transport.describe(signal); }
  async invoke(request: TargetOperationRequest, signal?: AbortSignal): Promise<TargetOperationResult> { await this.ensureAuthenticated(); return this.transport.invoke(request, signal); }
  cancel(requestId: string): Promise<void> { return this.transport.cancel(requestId); }
  private async ensureAuthenticated(): Promise<void> { if (this.authenticated) return; if (!await this.authenticate(this.proof)) throw new Error("TARGET_AUTHENTICATION_FAILED"); this.authenticated = true; }
}

/** Deterministic transport fixture with an independent workspace and bounded operations. */
export class InMemoryTargetTransport implements TargetTransport {
  private readonly files = new Map<string, string>();
  private readonly cancelled = new Set<string>();
  constructor(private readonly description: TargetDescription, files: Readonly<Record<string, string>> = {}) { for (const [path, content] of Object.entries(files)) this.files.set(path, content); }
  async describe(): Promise<TargetDescription> { return this.description; }
  async invoke(request: TargetOperationRequest): Promise<TargetOperationResult> {
    const startedAt = new Date().toISOString();
    if (this.cancelled.has(request.requestId)) return this.result(request, "cancelled", startedAt, { code: "CANCELLED", message: "Target operation was cancelled." });
    if (request.deadline !== undefined && request.deadline <= Date.now()) return this.result(request, "timed-out", startedAt, { code: "TIMEOUT", message: "Target operation deadline expired." });
    try {
      const input = request.input as { path?: string; content?: string; command?: string };
      if (request.operation !== "execution.run" && (!input.path || input.path.startsWith("/") || input.path.includes(".."))) throw new Error("TARGET_PATH_OUTSIDE_WORKSPACE");
      if (request.operation === "filesystem.read") { const content = this.files.get(input.path!); if (content === undefined) throw new Error("TARGET_FILE_NOT_FOUND"); return this.result(request, "completed", startedAt, undefined, { path: input.path, content }); }
      if (request.operation === "filesystem.write") { if (typeof input.content !== "string") throw new Error("TARGET_CONTENT_REQUIRED"); this.files.set(input.path!, input.content); return this.result(request, "completed", startedAt, undefined, { path: input.path, written: true }); }
      if (request.operation === "filesystem.delete") { this.files.delete(input.path!); return this.result(request, "completed", startedAt, undefined, { path: input.path, deleted: true }); }
      if (request.operation === "execution.run") { if (input.command !== "pwd" && input.command !== "node --version" && input.command !== "git --version" && input.command !== "docker --version") throw new Error("TARGET_COMMAND_NOT_ALLOWED"); return this.result(request, "completed", startedAt, undefined, { command: input.command, cwd: this.description.workspace?.path ?? "" }); }
      throw new Error("TARGET_OPERATION_UNSUPPORTED");
    } catch (error) { return this.result(request, "failed", startedAt, { code: "TARGET_OPERATION_FAILED", message: error instanceof Error ? error.message : "Target operation failed." }); }
  }
  async cancel(requestId: string): Promise<void> { this.cancelled.add(requestId); }
  private result(request: TargetOperationRequest, status: TargetOperationResult["status"], startedAt: string, error?: TargetOperationResult["error"], output?: unknown): TargetOperationResult { return { requestId: request.requestId, targetId: request.targetId, operation: request.operation, status, ...(output === undefined ? {} : { output }), ...(error ? { error } : {}), startedAt, finishedAt: new Date().toISOString() }; }
}

export function targetRequest(targetId: string, workspaceId: string, operation: TargetOperation, input: unknown, deadline?: number): TargetOperationRequest { return { requestId: randomUUID(), targetId, workspaceId, operation, input, ...(deadline === undefined ? {} : { deadline }) }; }
