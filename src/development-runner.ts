import { ApplicationGateway, KernelEvent, failure } from "./contracts.js";
import { DevelopmentExecutionCategory, DevelopmentInterventionAction, DevelopmentPhase, DevelopmentState, Task, TaskStore } from "./task.js";
import { AttentionReason } from "./attention.js";
import { ExecutionTarget, TargetRegistry, ExecutionTargetCapability } from "./target.js";

export interface DevelopmentPhaseContext { readonly task: Task; readonly state: DevelopmentState; readonly input?: string; readonly target?: ExecutionTarget }
export type DevelopmentPhaseResult =
  | { readonly type: "advance"; readonly phase: DevelopmentPhase; readonly patch?: Partial<DevelopmentState>; readonly event?: string }
  | { readonly type: "attention"; readonly reason: AttentionReason; readonly message: string; readonly action?: DevelopmentInterventionAction; readonly event?: string };
export interface DevelopmentPhaseDriver { run(context: DevelopmentPhaseContext): Promise<DevelopmentPhaseResult> }

/** Normal Porta agent bridge. It adds no tools or permissions; it only gives
 * the existing gateway a bounded phase-specific objective. */
export class GatewayDevelopmentPhaseDriver implements DevelopmentPhaseDriver {
  constructor(private readonly gateway: ApplicationGateway) {}
  async run(context: DevelopmentPhaseContext): Promise<DevelopmentPhaseResult> {
    const gateway = context.target?.gateway ?? this.gateway;
    for await (const event of gateway.execute({ type: "SubmitInput", sessionId: context.task.sessionId, input: phasePrompt(context) }, {})) {
      if (event.type === "ApprovalRequested") {
        void drain(gateway.execute({ type: "CancelExecution", sessionId: context.task.sessionId }, {}));
        return { type: "attention", reason: "approval_required", message: `Approval is required for ${event.toolId}.`, action: "approve" };
      }
      if (event.type === "Error") return { type: "attention", reason: "execution_failed", message: event.error.message, action: "resume" };
    }
    return { type: "advance", phase: nextPhase(context.state.phase), event: `${context.state.phase} agent execution completed.` };
  }
}
function phasePrompt(context: DevelopmentPhaseContext): string { const state = context.state; const commands = state.phase === "verifying_focused" ? state.focusedCommands : state.phase === "verifying_full" ? state.fullCommands : []; return `You are operating one bounded phase of a persisted Porta development task. Do not claim completion without evidence.\nPhase: ${state.phase}\nGoal: ${state.goal}\nAcceptance criteria: ${state.acceptance?.map((entry) => `${entry.id}: ${entry.description} (${entry.status})`).join("; ") ?? state.acceptanceCriteria.join("; ")}\nWorkspace: ${state.workspace.path}\n${commands.length ? `Run these verification commands through the existing execution capability: ${commands.join(" && ")}` : "Use the existing filesystem, git, task, and artifact capabilities appropriate to this phase."}\nUpdate task state and evidence as needed. ${context.input ? `Human input: ${context.input}` : ""}`; }
function finishRecord(records: DevelopmentState["executionRecords"], id: string, status: "passed" | "failed", finishedAt: string, summary?: string): DevelopmentState["executionRecords"] { return (records ?? []).map((record) => record.id === id ? { ...record, status, finishedAt, ...(summary ? { output: { summary } } : {}) } : record); }
function requiredCapability(phase: DevelopmentPhase): ExecutionTargetCapability | undefined {
  if (["inspecting", "planning"].includes(phase)) return "filesystem.read";
  if (phase === "implementing") return "filesystem.write";
  if (["verifying", "verifying_focused", "verifying_full"].includes(phase)) return "execution.run";
  return undefined;
}
function nextPhase(phase: DevelopmentPhase): DevelopmentPhase { if (phase === "queued") return "inspecting"; if (phase === "inspecting") return "planning"; if (phase === "planning") return "implementing"; if (phase === "implementing") return "verifying_focused"; if (phase === "verifying_focused") return "verifying_full"; if (phase === "verifying_full") return "reviewing_diff"; if (phase === "reviewing_diff") return "ready_for_commit"; return phase; }
async function drain(source: AsyncIterable<KernelEvent>): Promise<void> { for await (const _event of source) {} }
export interface DevelopmentReleaseTarget {
  commit(input: { readonly message: string; readonly expectedRevision?: string }): Promise<{ readonly revision: string; readonly branch?: string; readonly subject: string }>;
  push(input: { readonly revision: string }): Promise<{ readonly revision: string; readonly remote?: string; readonly branch?: string }>;
  build(input: { readonly revision: string; readonly tag: string }): Promise<{ readonly reference: string; readonly repository: string; readonly tag: string; readonly sourceRevision: string; readonly digest?: string }>;
  pushImage(input: { readonly reference: string; readonly sourceRevision: string; readonly repository: string; readonly tag: string; readonly digest?: string }): Promise<{ readonly reference: string; readonly repository: string; readonly tag: string; readonly sourceRevision: string; readonly digest?: string; readonly latestReference?: string }>;
}
export interface DeploymentCoordinator {
  deploy(input: { readonly deploymentId: string; readonly sourceRevision: string; readonly imageReference: string; readonly imageDigest?: string; readonly previousRevision?: string; readonly previousImageReference?: string }): Promise<{ readonly status: "triggered" | "failed"; readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number }>;
  qualify(input: { readonly sessionId: string; readonly taskId: string; readonly deploymentId: string; readonly expectedRevision: string }): Promise<{ readonly ready: boolean; readonly correctRevision: boolean; readonly taskStateAvailable: boolean; readonly observedRevision?: string; readonly message?: string }>;
}
export interface DevelopmentReleaseCapabilities extends DevelopmentReleaseTarget, DeploymentCoordinator {}
export interface DevelopmentLocalQualification { qualify(input: { readonly sessionId: string; readonly taskId: string; readonly deploymentId: string; readonly expectedRevision: string }): Promise<{ readonly ready: boolean; readonly correctRevision: boolean; readonly taskStateAvailable: boolean; readonly observedRevision?: string; readonly message?: string }> }
export interface DevelopmentRunnerOptions { readonly maxTransitions?: number; readonly now?: () => string; readonly release?: DevelopmentReleaseCapabilities; readonly developmentReleaseTarget?: DevelopmentReleaseTarget; readonly deploymentCoordinator?: DeploymentCoordinator; readonly localQualification?: DevelopmentLocalQualification; readonly targets?: TargetRegistry }

/**
 * Persistent, phase-oriented workflow coordinator. The driver performs work
 * through normal Porta capabilities; this class owns only durable state,
 * intervention, and restart-safe phase boundaries.
 */
export class DevelopmentRunner {
  private readonly active = new Set<string>();
  private readonly maxTransitions: number;
  private readonly now: () => string;
  private readonly releaseCapabilities?: DevelopmentReleaseCapabilities;
  private readonly developmentReleaseTarget?: DevelopmentReleaseTarget;
  private readonly deploymentCoordinator?: DeploymentCoordinator;
  private readonly localQualification?: DevelopmentLocalQualification;
  private readonly targets?: TargetRegistry;
  constructor(private readonly tasks: TaskStore, private readonly driver: DevelopmentPhaseDriver, options: DevelopmentRunnerOptions = {}) {
    this.maxTransitions = options.maxTransitions ?? 16;
    this.now = options.now ?? (() => new Date().toISOString());
    this.releaseCapabilities = options.release;
    this.developmentReleaseTarget = options.developmentReleaseTarget;
    this.deploymentCoordinator = options.deploymentCoordinator;
    this.localQualification = options.localQualification;
    this.targets = options.targets;
  }

  async wake(sessionId: string): Promise<Task | undefined> {
    if (this.active.has(sessionId)) return this.tasks.get(sessionId);
    this.active.add(sessionId);
    try { return await this.run(sessionId); } finally { this.active.delete(sessionId); }
  }

  async release(sessionId: string): Promise<Task> {
    if (this.active.has(sessionId)) return this.requireTask(sessionId);
    this.active.add(sessionId);
    try {
      let task = await this.requireTask(sessionId); const state = this.requireState(task);
      const targetResolution = await this.resolveReleaseTarget(task);
      if (targetResolution.error) return this.releaseUnavailable(task, targetResolution.error);
      const release = targetResolution.release ?? this.releaseCapabilities;
      const coordinator = this.deploymentCoordinator ?? this.releaseCapabilities;
      if (!release || !coordinator) return this.releaseUnavailable(task, "Release or deployment capabilities are unavailable.");
      if (state.phase !== "ready_for_commit") throw failure("CAPABILITY_CONFLICT", "Development task is not ready for commit.");
      if (!state.permissions.commit || !state.permissions.push || !state.permissions.deploy) throw failure("AUTHORIZATION_DENIED", "Commit, push, and deploy permissions must be explicitly enabled.");
      if (!state.acceptance?.length || state.acceptance.some((criterion) => criterion.status !== "pass")) throw failure("POLICY_VIOLATION", "All acceptance criteria must pass before release.");
      const verification = state.executionRecords?.filter((record) => record.category === "verification");
      const latestVerification = new Map<string, NonNullable<DevelopmentState["executionRecords"]>[number]>(); for (const record of verification ?? []) latestVerification.set(record.command ?? record.id, record);
      if (!verification?.length || [...latestVerification.values()].some((record) => record.status !== "passed")) throw failure("POLICY_VIOLATION", "Verification must pass before release.");
      const baseRevision = state.originalRevision;
      task = await this.releaseStep(task, "committing", "git commit", "git", async () => { const result = await release.commit({ message: `porta: ${state.goal}`, ...(baseRevision ? { expectedRevision: baseRevision } : {}) }); return { phase: "pushing", patch: { commitSha: result.revision, originalRevision: baseRevision ?? result.revision, ...(result.branch ? { branch: result.branch } : {}), commitMessage: result.subject } }; });
      const commitSha = this.requireState(task).commitSha!;
      task = await this.releaseStep(task, "pushing", "git push", "git", async () => { const result = await release.push({ revision: commitSha }); if (result.revision !== commitSha) throw failure("CAPABILITY_CONFLICT", "Push revision does not match the committed revision."); return { phase: "building_image", patch: { push: { revision: result.revision, ...(result.remote ? { remote: result.remote } : {}), ...(result.branch ? { branch: result.branch } : {}) } } }; });
      task = await this.releaseStep(task, "building_image", "docker build", "build", async () => { const result = await release.build({ revision: commitSha, tag: commitSha.slice(0, 12) }); return { phase: "pushing_image", patch: { image: { reference: result.reference, tag: result.tag, ...(result.digest ? { digest: result.digest } : {}) } } }; });
      const image = this.requireState(task).image!;
      task = await this.releaseStep(task, "pushing_image", "docker push", "image_push", async () => { const result = await release.pushImage({ reference: image.reference, sourceRevision: commitSha, repository: image.reference.slice(0, image.reference.lastIndexOf(":")), tag: image.tag ?? commitSha.slice(0, 12), ...(image.digest ? { digest: image.digest } : {}) }); return { phase: "deploying", patch: { image: { reference: result.reference, tag: result.tag, ...(result.digest ? { digest: result.digest } : {}), ...(result.latestReference ? { latestReference: result.latestReference } : {}) } } }; });
      const deploymentId = `deployment-${task.id}-${this.now()}`;
      const latest = this.requireState(task); const prepared = { target: latest.deployment?.target ?? "porta-nas", deploymentId, sourceCommit: commitSha, imageReference: latest.image!.reference, ...(latest.image?.digest ? { imageDigest: latest.image.digest } : {}), ...(latest.deployment?.previousCommit ? { previousCommit: latest.deployment.previousCommit } : {}), ...(latest.deployment?.previousImageReference ? { previousImageReference: latest.deployment.previousImageReference } : {}), status: "prepared" as const, startedAt: this.now(), attempts: (latest.deployment?.attempts ?? 0) + 1 };
      task = await this.tasks.update(sessionId, task.id, task.version, { type: "set_development", development: { ...latest, phase: "deploying", deployment: prepared, lastEvent: "Durable deployment handoff persisted.", updatedAt: this.now() } });
      let handoff: Awaited<ReturnType<DeploymentCoordinator["deploy"]>>;
      try { handoff = await coordinator.deploy({ deploymentId, sourceRevision: commitSha, imageReference: latest.image!.reference, ...(latest.image?.digest ? { imageDigest: latest.image.digest } : {}), ...(prepared.previousCommit ? { previousRevision: prepared.previousCommit } : {}), ...(prepared.previousImageReference ? { previousImageReference: prepared.previousImageReference } : {}) }); } catch (error) { return this.releaseFailure(task, error instanceof Error ? error.message : "Deployment trigger state is unknown."); }
      if (handoff.status !== "triggered") return this.releaseFailure(task, "Deployment trigger failed.");
      return this.tasks.update(sessionId, task.id, task.version, { type: "set_development", development: { ...this.requireState(task), phase: "health_checking", deployment: { ...prepared, status: "awaiting_recovery" }, lastEvent: "Deployment triggered; awaiting replacement qualification.", updatedAt: this.now() } });
    } finally { this.active.delete(sessionId); }
  }

  async recover(sessionId: string): Promise<Task> {
    if (!this.releaseCapabilities && !this.deploymentCoordinator && !this.localQualification) throw failure("CAPABILITY_UNAVAILABLE", "No deployment qualification capability is configured.");
    const task = await this.requireTask(sessionId); const state = this.requireState(task); const deployment = state.deployment;
    if (!["deploying", "health_checking"].includes(state.phase) || !deployment || !["prepared", "triggered", "awaiting_recovery"].includes(deployment.status)) return task;
    const qualify = this.deploymentCoordinator?.qualify ?? this.releaseCapabilities?.qualify ?? this.localQualification!.qualify;
    const result = await qualify({ sessionId, taskId: task.id, deploymentId: deployment.deploymentId ?? "unknown", expectedRevision: state.commitSha ?? deployment.sourceCommit ?? "" });
    const now = this.now();
    if (!result.ready || !result.correctRevision || !result.taskStateAvailable) return this.tasks.update(sessionId, task.id, task.version, { type: "set_development", development: { ...state, attention: { reason: "deployment_failed", message: result.message ?? "Post-deployment qualification failed." }, pendingIntervention: { action: "resume", message: result.message ?? "Post-deployment qualification failed.", requestedAt: now }, deployment: { ...deployment, status: "failed", finishedAt: now, failureReason: result.message }, lastEvent: result.message ?? "Post-deployment qualification failed.", updatedAt: now } });
    const updated = await this.tasks.update(sessionId, task.id, task.version, { type: "set_development", development: { ...state, phase: "completed", attention: undefined, pendingIntervention: undefined, deployment: { ...deployment, status: "succeeded", finishedAt: now }, lastEvent: "Replacement instance qualified successfully.", updatedAt: now } });
    return this.tasks.update(sessionId, updated.id, updated.version, { type: "complete" });
  }

  async intervene(sessionId: string, expectedVersion: number, action: DevelopmentInterventionAction, input?: string, message?: string): Promise<Task> {
    const task = await this.requireTask(sessionId);
    const state = this.requireState(task);
    if (task.version !== expectedVersion) throw failure("CAPABILITY_CONFLICT", "Development intervention is stale.", false, { expectedVersion, actualVersion: task.version });
    if (!state.pendingIntervention && action !== "resume") throw failure("CAPABILITY_CONFLICT", "This development task is not waiting for intervention.");
    if (action === "provide_input" && !input?.trim()) throw failure("VALIDATION_FAILED", "Intervention input must not be empty.");
    const timestamp = this.now();
    const next: DevelopmentState = {
      ...state,
      ...(action === "cancel" ? { phase: "failed" as const, lastEvent: message ?? "Cancelled by user." } : action === "reject" ? { phase: "blocked" as const, lastEvent: message ?? "Rejected by user." } : { phase: state.phase }),
      attention: undefined,
      pendingIntervention: undefined,
      ...(input ? { interventionInput: input } : {}),
      execution: { phase: state.phase, status: "idle", attempt: state.execution?.attempt ?? 0, startedAt: state.execution?.startedAt ?? timestamp, ...(state.execution?.finishedAt ? { finishedAt: state.execution.finishedAt } : {}) },
      lastEvent: message ?? `Human intervention: ${action}`,
      updatedAt: timestamp,
    };
    const updated = await this.tasks.update(sessionId, task.id, expectedVersion, { type: "set_development", development: next });
    if (action === "cancel") return (await this.tasks.update(sessionId, task.id, updated.version, { type: "set_status", status: "cancelled", reason: "cancelled_by_user" }));
    if (action === "reject") return (await this.tasks.update(sessionId, task.id, updated.version, { type: "set_status", status: "blocked", reason: "rejected_by_user" }));
    return updated;
  }

  private async releaseStep(task: Task, phase: DevelopmentPhase, command: string, category: DevelopmentExecutionCategory, action: () => Promise<{ readonly phase: DevelopmentPhase; readonly patch?: Partial<DevelopmentState> }>): Promise<Task> {
    const state = this.requireState(task); const startedAt = this.now(); const recordId = `release-${task.id}-${phase}-${(state.execution?.attempt ?? 0) + 1}`;
    const running: DevelopmentState = { ...state, phase, executionRecords: [...(state.executionRecords ?? []), { id: recordId, category, ...(state.developmentTargetId ? { targetId: state.developmentTargetId } : {}), command, startedAt, status: "running" }], execution: { phase, status: "running", attempt: (state.execution?.attempt ?? 0) + 1, startedAt }, lastEvent: `Started ${phase}.`, updatedAt: startedAt };
    task = await this.tasks.update(task.sessionId, task.id, task.version, { type: "set_development", development: running });
    try { const result = await action(); const finishedAt = this.now(); const next: DevelopmentState = { ...running, ...(result.patch ?? {}), phase: result.phase, executionRecords: finishRecord(running.executionRecords, recordId, "passed", finishedAt, `${phase} completed.`), execution: { ...running.execution!, status: "completed", finishedAt }, lastEvent: `${phase} completed.`, updatedAt: finishedAt }; return this.tasks.update(task.sessionId, task.id, task.version, { type: "set_development", development: next }); }
    catch (error) { const finishedAt = this.now(); const message = error instanceof Error ? error.message : `${phase} failed.`; const failed: DevelopmentState = { ...running, executionRecords: finishRecord(running.executionRecords, recordId, "failed", finishedAt, message), attention: { reason: "execution_failed", message }, pendingIntervention: { action: "resume", message, requestedAt: finishedAt }, execution: { ...running.execution!, status: "failed", finishedAt }, lastEvent: message, updatedAt: finishedAt }; await this.tasks.update(task.sessionId, task.id, task.version, { type: "set_development", development: failed }); throw error; }
  }
  private async releaseFailure(task: Task, message: string): Promise<Task> { const state = this.requireState(task); const now = this.now(); return this.tasks.update(task.sessionId, task.id, task.version, { type: "set_development", development: { ...state, attention: { reason: "deployment_failed", message }, pendingIntervention: { action: "resume", message, requestedAt: now }, deployment: state.deployment ? { ...state.deployment, status: "unknown", failureReason: message, finishedAt: now } : undefined, lastEvent: message, updatedAt: now } }); }

  private async run(sessionId: string): Promise<Task | undefined> {
    let task = await this.tasks.get(sessionId);
    if (!task?.development) return task;
    for (let transition = 0; transition < this.maxTransitions; transition++) {
      const state = this.requireState(task);
      if (state.phase === "ready_for_commit" || state.phase === "completed" || state.phase === "failed" || state.phase === "blocked" || state.attention || state.pendingIntervention) return task;
      if (state.execution?.status === "running") return this.pauseInterrupted(task, "A phase was interrupted before its result was persisted.");
      const targetResult = await this.resolveTarget(task, state.phase);
      if (targetResult.error) return this.pause(task, "target_unavailable", targetResult.error);
      const startedAt = this.now();
      const recordId = `execution-${task.id}-${(state.execution?.attempt ?? 0) + 1}`;
      const recordCategory = state.phase === "verifying_focused" || state.phase === "verifying_full" ? "verification" as const : "development" as const;
      const record = { id: recordId, category: recordCategory, ...(recordCategory === "verification" ? { command: (state.phase === "verifying_focused" ? state.focusedCommands : state.fullCommands).join(" && ") } : {}), startedAt, status: "running" as const };
      const running: DevelopmentState = { ...state, executionRecords: [...(state.executionRecords ?? []), record], execution: { phase: state.phase, status: "running", attempt: (state.execution?.attempt ?? 0) + 1, startedAt }, lastEvent: `Started ${state.phase}.`, updatedAt: startedAt };
      task = await this.tasks.update(sessionId, task.id, task.version, { type: "set_development", development: running });
      let result: DevelopmentPhaseResult;
      try { result = await this.driver.run({ task, state: running, ...(running.interventionInput ? { input: running.interventionInput } : {}), ...(targetResult.target ? { target: targetResult.target } : {}) }); }
      catch (error) { return this.pauseFailure(task, error instanceof Error ? error.message : "Development phase failed."); }
      const finishedAt = this.now();
      if (result.type === "attention") {
        const waiting: DevelopmentState = { ...running, executionRecords: finishRecord(running.executionRecords, recordId, "failed", finishedAt, result.message), attention: { reason: result.reason, message: result.message }, pendingIntervention: { action: result.action ?? "resume", message: result.message, requestedAt: finishedAt }, execution: { ...running.execution!, status: "failed", finishedAt }, lastEvent: result.event ?? result.message, updatedAt: finishedAt };
        task = await this.tasks.update(sessionId, task.id, task.version, { type: "set_development", development: waiting });
        return task;
      }
      const proposed = { ...running, ...(result.patch ?? {}) };
      if (result.phase === "ready_for_commit" && (!proposed.acceptance?.length || proposed.acceptance.some((criterion) => criterion.status !== "pass"))) {
        const message = "Acceptance criteria are not all passing; review the evidence before continuing.";
        const waiting: DevelopmentState = { ...proposed, executionRecords: finishRecord(running.executionRecords, recordId, "failed", finishedAt, message), attention: { reason: "verification_failed", message }, pendingIntervention: { action: "resume", message, requestedAt: finishedAt }, execution: { ...running.execution!, status: "failed", finishedAt }, lastEvent: message, updatedAt: finishedAt };
        task = await this.tasks.update(sessionId, task.id, task.version, { type: "set_development", development: waiting });
        return task;
      }
      const next: DevelopmentState = { ...proposed, executionRecords: finishRecord(running.executionRecords, recordId, "passed", finishedAt, result.event), phase: result.phase, attention: undefined, pendingIntervention: undefined, execution: { ...running.execution!, status: "completed", finishedAt }, lastEvent: result.event ?? `Completed ${running.phase}.`, updatedAt: finishedAt };
      task = await this.tasks.update(sessionId, task.id, task.version, { type: "set_development", development: next });
    }
    return this.pauseFailure(task, "Development transition limit exceeded.");
  }

  private async resolveReleaseTarget(task: Task): Promise<{ readonly release?: DevelopmentReleaseTarget; readonly error?: string }> {
    const targetId = this.requireState(task).developmentTargetId;
    if (!targetId) return {};
    if (!this.targets) return { error: `Development target '${targetId}' is not configured.` };
    const resolved = await this.targets.qualify(targetId);
    if (!resolved) return { error: `Development target '${targetId}' is unavailable.` };
    const taskWorkspace = this.requireState(task).workspace;
    const targetWorkspace = resolved.target.workspace;
    if (!targetWorkspace || (taskWorkspace.id && targetWorkspace.id !== taskWorkspace.id) || targetWorkspace.path !== taskWorkspace.path) return { error: `Development target '${targetId}' is not bound to the task workspace.` };
    const required: readonly ExecutionTargetCapability[] = ["git.commit", "git.push", "image.build", "image.push"];
    const missing = required.find((capability) => !resolved.capabilities.includes(capability));
    if (missing) return { error: `Development target '${targetId}' lacks capability '${missing}'.` };
    if (!resolved.target.release) return { error: `Development target '${targetId}' has no release capability.` };
    return { release: resolved.target.release };
  }

  private async releaseUnavailable(task: Task, message: string): Promise<Task> {
    const state = this.requireState(task); const now = this.now();
    return this.tasks.update(task.sessionId, task.id, task.version, { type: "set_development", development: { ...state, attention: { reason: "target_unavailable", message }, pendingIntervention: { action: "resume", message, requestedAt: now }, lastEvent: message, updatedAt: now } });
  }

  private async resolveTarget(task: Task, phase: DevelopmentPhase): Promise<{ readonly target?: ExecutionTarget; readonly error?: string }> {
    const targetId = this.requireState(task).developmentTargetId;
    if (!targetId) return {};
    if (!this.targets) return { error: `Development target '${targetId}' is not configured.` };
    const resolved = await this.targets.qualify(targetId);
    if (!resolved) return { error: `Development target '${targetId}' is unavailable.` };
    const required = requiredCapability(phase);
    if (required && !resolved.capabilities.includes(required)) return { error: `Development target '${targetId}' lacks capability '${required}'.` };
    return { target: resolved.target };
  }

  private async pauseInterrupted(task: Task, message: string): Promise<Task> {
    return this.pause(task, "execution_failed", message);
  }
  private async pauseFailure(task: Task, message: string): Promise<Task> {
    return this.pause(task, "execution_failed", message);
  }
  private async pause(task: Task, reason: AttentionReason, message: string): Promise<Task> {
    const state = this.requireState(task); const timestamp = this.now();
    return this.tasks.update(task.sessionId, task.id, task.version, { type: "set_development", development: { ...state, executionRecords: finishRecord(state.executionRecords, `execution-${task.id}-${state.execution?.attempt ?? 0}`, "failed", timestamp, message), attention: { reason, message }, pendingIntervention: { action: "resume", message, requestedAt: timestamp }, execution: state.execution ? { ...state.execution, status: "failed", finishedAt: timestamp } : undefined, lastEvent: message, updatedAt: timestamp } });
  }
  private async requireTask(sessionId: string): Promise<Task> { const task = await this.tasks.get(sessionId); if (!task) throw failure("CAPABILITY_UNAVAILABLE", "Development task was not found."); return task; }
  private requireState(task: Task): DevelopmentState { if (!task.development) throw failure("CAPABILITY_UNAVAILABLE", "Task is not a development task."); return task.development; }
}
