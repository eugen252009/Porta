import { z } from "zod";
import type { JsonValue, ModelMessage, ModelToolCall, ModelToolResult } from "./contracts.js";

/** Durable boundaries of an agent execution. Runtime objects and waiters are deliberately absent. */
export type DurableExecutionPhase =
  | "queued" | "starting" | "model_running" | "model_completed"
  | "tool_call_pending" | "approval_required" | "tool_authorized"
  | "tool_running" | "tool_completed" | "continuation_pending"
  | "completed" | "failed" | "cancelled" | "recovery_required";
export type DurableToolExecutionState = "prepared" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface DurableToolExecution {
  readonly toolExecutionId: string; readonly executionId: string; readonly toolCallId: string;
  readonly toolId: string; readonly input: JsonValue; readonly state: DurableToolExecutionState;
  readonly retrySafe: boolean; readonly result?: ModelToolResult; readonly error?: string;
  readonly createdAt: string; readonly updatedAt: string;
}
export interface DurableExecution {
  readonly executionId: string; readonly taskId?: string; readonly sessionId: string;
  readonly nodeId?: string; readonly traceId: string; readonly phase: DurableExecutionPhase;
  readonly version: number; readonly input: string; readonly history: readonly ModelMessage[];
  readonly modelOutput?: { readonly content?: string; readonly toolCalls?: readonly ModelToolCall[] };
  readonly currentToolCall?: ModelToolCall; readonly approvalId?: string;
  readonly tool?: DurableToolExecution; readonly failure?: string;
  readonly createdAt: string; readonly updatedAt: string;
}
export interface ExecutionPersistence {
  get(executionId: string): DurableExecution | undefined;
  listIncomplete(): readonly DurableExecution[];
  save(execution: DurableExecution, expectedVersion?: number): void;
}

export class MemoryExecutionPersistence implements ExecutionPersistence {
  private readonly values = new Map<string, DurableExecution>();
  get(id: string) { return this.values.get(id); }
  listIncomplete() { return [...this.values.values()].filter((e) => !["completed", "failed", "cancelled"].includes(e.phase)); }
  save(execution: DurableExecution, expectedVersion?: number) {
    const current = this.values.get(execution.executionId);
    if (current && expectedVersion !== undefined && current.version !== expectedVersion) throw new Error("Execution checkpoint is stale.");
    if (current && expectedVersion === undefined && execution.version <= current.version) throw new Error("Execution checkpoint version must increase.");
    this.values.set(execution.executionId, execution);
  }
}

export const durableExecutionSchema = z.object({
  executionId: z.string(), taskId: z.string().optional(), sessionId: z.string(), nodeId: z.string().optional(), traceId: z.string(),
  phase: z.enum(["queued", "starting", "model_running", "model_completed", "tool_call_pending", "approval_required", "tool_authorized", "tool_running", "tool_completed", "continuation_pending", "completed", "failed", "cancelled", "recovery_required"]),
  version: z.number().int().positive(), input: z.string(), history: z.array(z.unknown()),
  modelOutput: z.object({ content: z.string().optional(), toolCalls: z.array(z.unknown()).optional() }).optional(), currentToolCall: z.unknown().optional(), approvalId: z.string().optional(),
  tool: z.object({ toolExecutionId: z.string(), executionId: z.string(), toolCallId: z.string(), toolId: z.string(), input: z.unknown(), state: z.enum(["prepared", "running", "succeeded", "failed", "cancelled", "unknown"]), retrySafe: z.boolean(), result: z.unknown().optional(), error: z.string().optional(), createdAt: z.string(), updatedAt: z.string() }).optional(),
  failure: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export function parseDurableExecution(value: unknown): DurableExecution {
  const parsed = durableExecutionSchema.safeParse(value);
  if (!parsed.success) throw new Error("Persisted execution state is invalid.");
  return parsed.data as DurableExecution;
}
