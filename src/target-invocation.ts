import { randomUUID } from "node:crypto";
import type { ApprovalProvider, JsonValue, ToolAuthorizationPolicy, ToolContext } from "./contracts.js";
import type { TargetOperation, TargetOperationResult } from "./target-transport.js";
import type { TargetRegistry } from "./target.js";

export interface TargetInvocationRequest { readonly targetId: string; readonly workspaceId: string; readonly operation: TargetOperation; readonly input: unknown; readonly sessionId?: string; readonly traceId?: string; readonly deadline?: number }
export interface TargetInvocationEvidence { readonly invocationId: string; readonly targetId: string; readonly workspaceId: string; readonly capability: string; readonly operation: TargetOperation; readonly status: "pending" | "completed" | "failed" | "denied" | "cancelled" | "timed-out"; readonly startedAt: string; readonly finishedAt?: string; readonly output?: unknown; readonly error?: { readonly code: string; readonly message: string }; readonly approvalId?: string }

/** Orchestrator-owned target invocation. It never constructs a target or bypasses policy. */
export class TargetInvocationService {
  private readonly records = new Map<string, { evidence: TargetInvocationEvidence; cancel: () => void }>();
  constructor(private readonly targets: TargetRegistry, private readonly policy: ToolAuthorizationPolicy, private readonly approvals: ApprovalProvider) {}
  start(request: TargetInvocationRequest): TargetInvocationEvidence {
    const invocationId = randomUUID(); const startedAt = new Date().toISOString(); const controller = new AbortController(); const capability = capabilityFor(request.operation); const target = this.targets.resolve(request.targetId);
    const initial: TargetInvocationEvidence = { invocationId, targetId: request.targetId, workspaceId: request.workspaceId, capability, operation: request.operation, status: "pending", startedAt };
    this.records.set(invocationId, { evidence: initial, cancel: () => { controller.abort(); void target?.transport?.cancel(invocationId); } });
    void this.execute(invocationId, request, controller, initial).catch((error) => this.finish(invocationId, { status: "failed", error: normalizeError(error) }));
    return initial;
  }
  get(invocationId: string): TargetInvocationEvidence | undefined { return this.records.get(invocationId)?.evidence; }
  cancel(invocationId: string): boolean { const entry = this.records.get(invocationId); if (!entry) return false; entry.cancel(); return true; }
  private async execute(id: string, request: TargetInvocationRequest, controller: AbortController, initial: TargetInvocationEvidence): Promise<void> {
    const capability = capabilityFor(request.operation); const target = this.targets.resolve(request.targetId); if (!target) return this.finish(id, { status: "failed", error: { code: "TARGET_UNAVAILABLE", message: `Target '${request.targetId}' is not configured.` } });
    const available = await target.available(); if (!available) return this.finish(id, { status: "failed", error: { code: "TARGET_UNAVAILABLE", message: `Target '${request.targetId}' is unavailable or identity-bound metadata mismatched.` } });
    if (target.workspace?.id !== request.workspaceId) return this.finish(id, { status: "failed", error: { code: "WORKSPACE_MISMATCH", message: "Invocation workspace does not match the registered target workspace." } });
    const capabilities = await target.capabilities(); if (!capabilities.includes(capability as never)) return this.finish(id, { status: "failed", error: { code: "CAPABILITY_UNAVAILABLE", message: `Target lacks capability '${capability}'.` } });
    const context: ToolContext = { traceId: request.traceId ?? `target-invocation-${id}`, sessionId: request.sessionId ?? `target-invocation-${id}`, executionId: id, signal: controller.signal, ...(request.deadline === undefined ? {} : { deadline: request.deadline }) };
    const decision = await this.policy.authorize({ toolCallId: id, invocation: { schemaVersion: 1, requestId: id, toolId: toolIdFor(request.operation), input: request.input as JsonValue }, context });
    if (decision === "deny") return this.finish(id, { status: "denied", error: { code: "OPERATION_DENIED", message: "Target operation was denied by orchestrator policy." } });
    let approvalId: string | undefined;
    if (decision === "require-approval") { approvalId = `approval-${id}`; const approval = await this.approvals.approve({ approvalId, toolCallId: id, invocation: { schemaVersion: 1, requestId: id, toolId: toolIdFor(request.operation), input: request.input as JsonValue }, context }); if (!approval.approved) return this.finish(id, { status: "denied", error: { code: "OPERATION_DENIED", message: approval.reason ?? "Target operation was not approved." }, approvalId }); }
    if (controller.signal.aborted) return this.finish(id, { status: request.deadline !== undefined && request.deadline <= Date.now() ? "timed-out" : "cancelled", approvalId });
    const result = await target.invoke!(request.operation, request.input, { signal: controller.signal, ...(request.deadline === undefined ? {} : { deadline: request.deadline }) });
    this.finish(id, { status: result.status, ...(result.output === undefined ? {} : { output: result.output }), ...(result.error ? { error: result.error } : {}), ...(approvalId ? { approvalId } : {}) });
  }
  private finish(id: string, patch: Partial<TargetInvocationEvidence>): void { const entry = this.records.get(id); if (!entry || entry.evidence.status !== "pending") return; entry.evidence = { ...entry.evidence, ...patch, ...(patch.finishedAt ? {} : { finishedAt: new Date().toISOString() }) }; }
}
function toolIdFor(operation: TargetOperation): string { return operation === "execution.run" ? "execution/run" : operation.replace(".", "/"); }
function capabilityFor(operation: TargetOperation): string { return operation === "execution.run" ? "execution.run" : operation === "filesystem.read" ? "filesystem.read" : "filesystem.write"; }
function normalizeError(error: unknown): { code: string; message: string } { if (error && typeof error === "object" && "error" in error) { const value = (error as { error?: { code?: string; message?: string } }).error; if (value?.code && value.message) return { code: value.code, message: value.message }; } return { code: "TARGET_INVOCATION_FAILED", message: error instanceof Error ? error.message : "Target invocation failed." }; }
