export type AttentionReason = "approval_required" | "user_input_required" | "execution_failed" | "target_unavailable" | "repository_dirty" | "verification_failed" | "deployment_failed" | "rollback_failed" | "credentials_unavailable";
export interface AttentionState { readonly required: boolean; readonly reason?: AttentionReason }
export interface AttentionInput { status: string; connection?: "available" | "unavailable"; waitingFor?: "approval" | "user" | "machine"; reason?: AttentionReason }
export function attentionFor(input: AttentionInput): AttentionState {
  if (input.reason) return { required: true, reason: input.reason };
  if (input.connection === "unavailable") return { required: true, reason: "target_unavailable" };
  if (input.waitingFor === "approval") return { required: true, reason: "approval_required" };
  if (input.waitingFor === "user") return { required: true, reason: "user_input_required" };
  if (input.status === "failed") return { required: true, reason: "execution_failed" };
  return { required: false };
}
export function attentionTransition(previous: AttentionState | undefined, next: AttentionState): boolean { return !previous?.required && next.required; }
