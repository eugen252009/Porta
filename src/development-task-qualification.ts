import { randomUUID } from "node:crypto";
import type { TargetInvocationEvidence, TargetInvocationService } from "./target-invocation.js";
import type { DevelopmentState, Task, TaskStore } from "./task.js";
import type { TargetRegistry } from "./target.js";
import type { ConversationStore } from "./contracts.js";
import { sessionFromBase } from "./conversation.js";

/** Bounded, model-independent lifecycle fixture for target reconnect qualification. */
export class DevelopmentTaskQualificationService {
  private readonly active = new Set<string>();
  constructor(private readonly tasks: TaskStore, private readonly invocations: TargetInvocationService, private readonly targets: TargetRegistry, private readonly conversations?: ConversationStore) {}
  async create(targetId: string): Promise<Task> {
    if (targetId !== "pc-main") throw new Error("Qualification target is fixed to the configured pc-main fixture.");
    const target = this.targets.resolve(targetId); if (!target || !(await target.available()) || !target.workspace) throw new Error("Qualification target is unavailable.");
    const sessionId = `qualification-${randomUUID()}`; const now = new Date().toISOString(); if (this.conversations) await this.conversations.createSession(sessionFromBase({ schemaVersion: 1, id: sessionId, state: "open", createdAt: now }));
    const development: DevelopmentState = { goal: "Qualify persistent remote target reconnect", acceptanceCriteria: ["harmless remote execution succeeds"], developmentTargetId: targetId, workspace: { id: target.workspace.id, path: target.workspace.path }, permissions: { mutate: false, commit: false, push: false, deploy: false }, focusedCommands: ["node --version"], fullCommands: ["node --version"], phase: "verifying_focused", updatedAt: now };
    const task = await this.tasks.create(sessionId, "Qualify persistent pc-main target reconnect", ["Disposable qualification only; do not modify source."], development);
    return this.tasks.update(sessionId, task.id, task.version, { type: "add_criterion", criterionId: "remote-execution", description: "Harmless node version execution succeeds on pc-main", required: true });
  }
  async run(sessionId: string): Promise<Task | undefined> { const task = await this.tasks.get(sessionId); if (!task?.development || this.active.has(sessionId)) return task; this.active.add(sessionId); void this.execute(task).finally(() => this.active.delete(sessionId)); return task; }
  private async execute(task: Task): Promise<void> {
    const state = task.development!; const running = await this.tasks.update(task.sessionId, task.id, task.version, { type: "set_development", development: { ...state, attention: undefined, pendingIntervention: undefined, currentAction: "Executing node --version on pc-main", phase: "verifying_focused", updatedAt: new Date().toISOString() } });
    const invocation = this.invocations.start({ targetId: state.developmentTargetId!, workspaceId: state.workspace.id!, operation: "execution.run", input: { command: "node", args: ["--version"] }, sessionId: task.sessionId });
    let evidence: TargetInvocationEvidence | undefined; for (let i = 0; i < 400; i++) { evidence = this.invocations.get(invocation.invocationId); if (evidence?.status !== "pending") break; await new Promise((resolve) => setTimeout(resolve, 25)); }
    const latest = await this.tasks.get(task.sessionId); if (!latest?.development || !evidence || evidence.status === "pending") return;
    if (evidence.status !== "completed") { await this.tasks.update(task.sessionId, latest.id, latest.version, { type: "set_development", development: { ...latest.development, attention: { reason: evidence.error?.code === "TARGET_UNAVAILABLE" ? "target_unavailable" : "execution_failed", message: evidence.error?.message ?? "Qualification invocation failed." }, pendingIntervention: { action: "resume", message: evidence.error?.message ?? "Qualification invocation failed.", requestedAt: new Date().toISOString() }, lastEvent: evidence.error?.message ?? "Qualification invocation failed.", updatedAt: new Date().toISOString() } }); return; }
    const withEvidence = await this.tasks.update(task.sessionId, latest.id, latest.version, { type: "add_evidence", criterionId: "remote-execution", source: "execution", outcome: "pass", summary: `pc-main returned ${String((evidence.output as { stdout?: string })?.stdout ?? "node version")}`, executionId: evidence.invocationId });
    const completed = await this.tasks.update(task.sessionId, withEvidence.id, withEvidence.version, { type: "set_development", development: { ...withEvidence.development!, phase: "completed", currentAction: undefined, lastEvent: "Remote target qualification completed.", updatedAt: new Date().toISOString() } });
    await this.tasks.update(task.sessionId, completed.id, completed.version, { type: "complete" });
  }
}
