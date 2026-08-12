import { randomUUID } from "node:crypto";
import { ExecutionPolicy, ExecutionRequest, ExecutionResult, ExecutionContext, HarnessFailure, RuntimeEvent, RuntimeExecution, RuntimeHost, SandboxProvider, failure, executionRequestSchema, sandboxBindingSchema } from "./contracts.js";

export interface ExecutionDecision { allowed: boolean; error?: { code: "POLICY_VIOLATION" | "VALIDATION_FAILED" | "TIMEOUT"; message: string; details?: unknown } }

export function evaluateExecutionPolicy(policy: ExecutionPolicy, capabilities: SandboxProvider["capabilities"]): ExecutionDecision {
  for (const dimension of ["filesystem", "network"] as const) {
    if (policy[dimension] === "deny" && capabilities[dimension] === "unsupported") return { allowed: false, error: { code: "POLICY_VIOLATION", message: `Sandbox cannot enforce denied ${dimension} access.`, details: { dimension, required: "deny", supported: capabilities[dimension] } } };
  }
  return { allowed: true };
}

export class RuntimeCoordinator {
  constructor(private readonly runtime: RuntimeHost, private readonly sandbox: SandboxProvider) {}
  async createExecution(request: ExecutionRequest, context: ExecutionContext): Promise<RuntimeExecution> {
    const parsed = executionRequestSchema.safeParse(request);
    if (!parsed.success) throw failure("VALIDATION_FAILED", "Execution request is invalid.", false, { issues: parsed.error.issues });
    if (context.deadline !== undefined && context.deadline <= Date.now()) throw failure("TIMEOUT", "Execution deadline has expired.", true);
    const decision = evaluateExecutionPolicy(request.policy, this.sandbox.capabilities);
    if (!decision.allowed) throw failure(decision.error!.code, decision.error!.message, false, decision.error!.details);
    let session;
    try {
      session = await this.sandbox.create(request.policy);
      if (session.binding) {
        const binding = sandboxBindingSchema.safeParse(session.binding);
        if (!binding.success) throw failure("SANDBOX_FAILED", "Sandbox returned an invalid binding envelope.", false, { issues: binding.error.issues });
        if (!this.runtime.supportedBindingKinds?.includes(session.binding.kind)) throw failure("POLICY_VIOLATION", `Runtime does not support sandbox binding '${session.binding.kind}'.`);
      }
      return new ManagedExecution(await this.runtime.createExecution(request, context, session), session);
    }
    catch (error) { if (session) await session.dispose(); throw error; }
  }
}

class ManagedExecution implements RuntimeExecution {
  readonly id: string;
  private disposed = false;
  constructor(private readonly execution: RuntimeExecution, private readonly sandbox: { dispose(): Promise<void> }) { this.id = execution.id; }
  events(): AsyncIterable<RuntimeEvent> { return this.withCleanup(this.execution.events()); }
  writeStdin(data: Uint8Array): Promise<void> { if (!this.execution.writeStdin) return Promise.reject(failure("RUNTIME_FAILED", "Runtime does not support stdin.")); return this.execution.writeStdin(data); }
  async cancel(reason?: string): Promise<void> { try { await this.execution.cancel(reason); } finally { await this.cleanup(); } }
  async result(): Promise<ExecutionResult> { try { return await this.execution.result(); } finally { await this.cleanup(); } }
  private async *withCleanup(events: AsyncIterable<RuntimeEvent>): AsyncIterable<RuntimeEvent> { try { yield* events; } finally { await this.cleanup(); } }
  private async cleanup(): Promise<void> { if (!this.disposed) { this.disposed = true; await this.sandbox.dispose(); } }
}

export interface RuntimePluginOptions { runtime: RuntimeHost; sandbox: SandboxProvider }
export const executionId = () => randomUUID();
