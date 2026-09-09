import type { ApplicationGateway, CommandContext, KernelEvent } from "./contracts.js";
import type { DevelopmentReleaseTarget } from "./development-runner.js";

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
}

export interface TargetResolution {
  readonly target: ExecutionTarget;
  readonly capabilities: readonly ExecutionTargetCapability[];
}

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
