import type { ApplicationGateway, CommandContext, KernelEvent } from "./contracts.js";
import type { DevelopmentReleaseTarget } from "./development-runner.js";
import { targetRequest } from "./target-transport.js";
import type { TargetOperation, TargetOperationResult, TargetTransport } from "./target-transport.js";

export type ExecutionTargetCapability = "filesystem.read" | "filesystem.write" | "execution.run" | "git.current_revision" | "git.status" | "git.diff" | "git.commit" | "git.push" | "image.build" | "image.push";

export interface ExecutionTarget {
  readonly id: string;
  readonly kind: string;
  readonly workspace?: { readonly id: string; readonly path: string };
  capabilities(): Promise<readonly ExecutionTargetCapability[]>;
  available(): Promise<boolean>;
  /** Optional target-bound gateway. The orchestrator still owns task state and approvals. */
  gateway?: ApplicationGateway;
  release?: DevelopmentReleaseTarget;
  transport?: TargetTransport;
  invoke?(operation: TargetOperation, input: unknown, context?: { readonly signal?: AbortSignal; readonly deadline?: number }): Promise<TargetOperationResult>;
}

export interface TargetResolution {
  readonly target: ExecutionTarget;
  readonly capabilities: readonly ExecutionTargetCapability[];
}

export class RemoteExecutionTarget implements ExecutionTarget {
  private description?: Awaited<ReturnType<TargetTransport["describe"]>>;
  constructor(readonly id: string, readonly kind: string, readonly transport: TargetTransport) {}
  get workspace(): { readonly id: string; readonly path: string } | undefined { return this.description?.workspace ? { id: this.description.workspace.id, path: this.description.workspace.path } : undefined; }
  async capabilities(): Promise<readonly ExecutionTargetCapability[]> { return (this.description ??= await this.transport.describe()).capabilities; }
  async available(): Promise<boolean> { try { return (this.description = await this.transport.describe()).available; } catch { return false; } }
  async invoke(operation: TargetOperation, input: unknown, context: { readonly signal?: AbortSignal; readonly deadline?: number } = {}): Promise<TargetOperationResult> { const description = this.description ??= await this.transport.describe(); if (!description.capabilities.includes(capabilityFor(operation))) throw new Error(`TARGET_CAPABILITY_UNAVAILABLE:${capabilityFor(operation)}`); const workspaceId = description.workspace?.id; if (!workspaceId) throw new Error("TARGET_WORKSPACE_UNAVAILABLE"); return this.transport.invoke(targetRequest(this.id, workspaceId, operation, input, context.deadline), context.signal); }
}
function capabilityFor(operation: TargetOperation): ExecutionTargetCapability { if (operation === "filesystem.read") return "filesystem.read"; if (operation === "filesystem.write" || operation === "filesystem.delete") return "filesystem.write"; return "execution.run"; }

export class TargetRegistry {
  private readonly targets = new Map<string, ExecutionTarget>();
  register(target: ExecutionTarget): void {
    if (this.targets.has(target.id)) throw new Error(`Execution target '${target.id}' is already registered.`);
    this.targets.set(target.id, target);
  }
  resolve(id: string): ExecutionTarget | undefined { return this.targets.get(id); }
  async qualify(id: string): Promise<TargetResolution | undefined> {
    const target = this.resolve(id);
    if (!target || !(await target.available())) return undefined;
    return { target, capabilities: await target.capabilities() };
  }
  list(): readonly ExecutionTarget[] { return [...this.targets.values()]; }
}

export interface TargetToolExecution {
  readonly targetId: string;
  readonly toolId: string;
  readonly context: CommandContext;
  readonly input: unknown;
}

export interface TargetExecutionEvidence {
  readonly targetId: string;
  readonly toolId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "passed" | "failed";
}

/** Small helper for target-bound gateways; it deliberately carries no credentials. */
export async function collectTargetEvents(target: ExecutionTarget, command: Parameters<ApplicationGateway["execute"]>[0], context: CommandContext = {}): Promise<readonly KernelEvent[]> {
  if (!target.gateway) throw new Error(`Execution target '${target.id}' has no gateway.`);
  const events: KernelEvent[] = [];
  for await (const event of target.gateway.execute(command, context)) events.push(event);
  return events;
}
