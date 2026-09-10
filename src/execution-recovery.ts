import type { DurableExecution, DurableExecutionPhase } from "./execution-persistence.js";

export type RecoveryAction = "enqueue" | "resume_model" | "wait_for_approval" | "execute_prepared_tool" | "continue_model" | "retry_tool" | "recovery_required" | "none";
export interface RecoveryDecision { readonly action: RecoveryAction; readonly reason: string }

/** Pure startup policy. It never invokes a model or tool and therefore is safe to run during hydration. */
export function recoveryDecision(execution: DurableExecution, taskStatus?: "pending" | "active" | "blocked" | "completed" | "failed" | "cancelled"): RecoveryDecision {
  if (taskStatus === "cancelled") return { action: "none", reason: "Cancellation takes precedence over recovery." };
  if (taskStatus === "failed" || taskStatus === "completed") return { action: "none", reason: "Durable task terminal state takes precedence over recovery." };
  switch (execution.phase) {
    case "queued": return { action: "enqueue", reason: "Queued execution was not started." };
    case "starting": case "model_running": return { action: "resume_model", reason: "Model request was interrupted before its result was committed." };
    case "model_completed": case "tool_call_pending": return execution.approvalId ? { action: "wait_for_approval", reason: "Persisted tool call is awaiting approval." } : { action: "execute_prepared_tool", reason: "Persisted model output is available for tool processing." };
    case "approval_required": return { action: "wait_for_approval", reason: "Approval remains authoritative and actionable only through the approval boundary." };
    case "tool_authorized": return { action: "execute_prepared_tool", reason: "Authorization was committed before tool invocation." };
    case "tool_running": return execution.tool?.retrySafe ? { action: "retry_tool", reason: "The tool explicitly declares retry-safe recovery." } : { action: "recovery_required", reason: "Tool outcome is ambiguous and replay is not declared safe." };
    case "tool_completed": case "continuation_pending": return { action: "continue_model", reason: "Tool result is committed; continue without invoking the tool again." };
    case "completed": case "failed": case "cancelled": case "recovery_required": return { action: "none", reason: "Terminal or human-recovery state is not resumed automatically." };
  }
}

export function isTerminalPhase(phase: DurableExecutionPhase): boolean { return phase === "completed" || phase === "failed" || phase === "cancelled"; }
