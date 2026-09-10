import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ModelDescriptor, ModelContext, ToolAuthorizationPolicy, ApprovalProvider, ToolContext, ToolDescriptor, ToolInvocation, ToolProvider, ToolResult } from "./contracts.js";
import { AgentExecution, AgentOrchestrator } from "./agent.js";
import { ToolRouter } from "./tools.js";
import { ScratchpadStore } from "./scratchpad.js";

export type DelegatedTaskStatus = "pending" | "running" | "completed" | "blocked" | "insufficient-confidence" | "budget-exhausted" | "tool-unavailable" | "failed" | "cancelled";
export type DelegationPermission = string;
export interface DelegatedResult { summary: string; findings?: readonly string[]; evidence?: readonly { reference: string; summary: string }[]; unresolvedQuestions?: readonly string[]; confidence?: "low" | "medium" | "high" }
export interface DelegatedAttempt { id: string; model: ModelDescriptor; startedAt: string; completedAt?: string; terminationReason?: string; result?: DelegatedResult; permissions: readonly DelegationPermission[] }
export interface DelegationContext { readonly originNodeId: string; readonly parentNodeId: string; readonly currentNodeId: string; readonly traceId: string; readonly delegationDepth: number; readonly maxDelegationDepth: number; readonly visitedNodeIds: readonly string[] }
export interface DelegatedTask { id: string; parentSessionId: string; objective: string; constraints?: readonly string[]; acceptanceCriteria?: readonly string[]; requestedModel?: string; budget?: DelegationRequest["budget"];  effectivePermissions: readonly DelegationPermission[]; scratchpadNamespace: string; status: DelegatedTaskStatus; attempts: readonly DelegatedAttempt[]; depth: number; version: number; createdAt: string; updatedAt: string; delegationId?: string; childTaskId?: string; parentNodeId?: string; parentIdentity?: string; childNodeId?: string; authority?: "local" | "child" | "parent-projection"; lastSeenAt?: string; stale?: boolean; restrictions?: readonly string[]; remoteResult?: DelegatedResult; context?: DelegationContext }
export interface ScratchpadPrefill { context?: readonly string[]; constraints?: readonly string[]; hypotheses?: readonly string[]; relevantFiles?: readonly string[] }
export interface DelegationRequest { objective: string; context?: DelegationContext; constraints?: readonly string[]; acceptanceCriteria?: readonly string[]; model?: string; restrict?: readonly DelegationPermission[]; budget?: { maxTurns?: number; maxToolCalls?: number; maxTokens?: number }; scratchpad?: ScratchpadPrefill }
export interface DelegationLimits { maxDepth: number; maxChildren: number }
export interface DelegatedTaskPersistence { load(): Promise<readonly DelegatedTask[]>; save(task: DelegatedTask): Promise<void> }
export interface DelegatedExecutionContext { task: DelegatedTask; attempt: DelegatedAttempt; scratchpad: ScratchpadStore }
export type DelegatedExecutor = (context: DelegatedExecutionContext) => Promise<DelegatedResult>
export interface RunDelegatedAttemptInput { taskId: string; model: import("./contracts.js").ModelProvider; tools: ToolRouter; policy: ToolAuthorizationPolicy; approvalProvider?: ApprovalProvider; signal?: AbortSignal; budget?: { maxTurns?: number; maxToolCalls?: number } }
export interface DelegatedAttemptResult { task: DelegatedTask; attempt: DelegatedAttempt; result?: DelegatedResult; execution: AgentExecution }
export type DelegatedAttemptRunner = (task: DelegatedTask) => Promise<DelegatedAttemptResult>;

export function effectivePermissions(parent: readonly DelegationPermission[], restrict: readonly DelegationPermission[] = []): readonly DelegationPermission[] { const denied = new Set(restrict); return parent.filter((permission) => !denied.has(permission)); }
export function canDelegate(permissions: readonly DelegationPermission[]): boolean { return permissions.includes("agent.delegate"); }

export interface DelegatedTaskMetadata { readonly delegationId: string; readonly parentNodeId: string; readonly parentIdentity: string; readonly childNodeId: string; readonly authority: "child" | "parent-projection"; readonly context?: DelegationContext }

export class DelegatedTaskStore {
  private readonly tasks = new Map<string, DelegatedTask>();
  constructor(private readonly scratchpad: ScratchpadStore, private readonly limits: DelegationLimits = { maxDepth: 2, maxChildren: 4 }, private readonly persistence?: DelegatedTaskPersistence) {}
  async restore(tasks: readonly DelegatedTask[]): Promise<void> { for (const task of tasks) { const normalized = { ...task, version: task.version ?? 1 }; const recovered = normalized.status === "running" ? { ...normalized, status: "failed" as const, attempts: normalized.attempts.map((attempt, index) => index === normalized.attempts.length - 1 && !attempt.completedAt ? { ...attempt, completedAt: new Date().toISOString(), terminationReason: "interrupted by process restart" } : attempt) } : normalized; this.tasks.set(recovered.id, recovered); if (recovered !== task) void this.persistence?.save(recovered); } }
  async create(parentSessionId: string, parentPermissions: readonly DelegationPermission[], request: DelegationRequest, depth = 0, allowDepthBoundary = false): Promise<DelegatedTask> {
    if (!request.objective.trim()) throw new Error("Delegated objective must not be empty.");
    if (!canDelegate(parentPermissions)) throw new Error("The parent does not have agent.delegate permission.");
    if (depth >= this.limits.maxDepth && !allowDepthBoundary) throw new Error("Delegation depth limit reached.");
    const children = [...this.tasks.values()].filter((task) => task.parentSessionId === parentSessionId).length;
    if (children >= this.limits.maxChildren) throw new Error("Delegation child limit reached.");
    const id = `delegated-${randomUUID()}`; const now = new Date().toISOString();
    const task: DelegatedTask = { id, parentSessionId, objective: request.objective, ...(request.context ? { context: request.context } : {}), ...(request.constraints ? { constraints: [...request.constraints] } : {}), ...(request.acceptanceCriteria ? { acceptanceCriteria: [...request.acceptanceCriteria] } : {}), ...(request.restrict ? { restrictions: [...request.restrict] } : {}), ...(request.model ? { requestedModel: request.model } : {}), ...(request.budget ? { budget: request.budget } : {}), effectivePermissions: effectivePermissions(parentPermissions, request.restrict), scratchpadNamespace: `delegation-${id}`, status: "pending", attempts: [], depth, version: 1, authority: "local", createdAt: now, updatedAt: now };
    this.tasks.set(id, task); void this.persistence?.save(task);
    await this.prefill(task, request.scratchpad);
    return cloneTask(task);
  }
  get(id: string): DelegatedTask | undefined { const task = this.tasks.get(id); return task ? cloneTask(task) : undefined; }
  list(): readonly DelegatedTask[] { return [...this.tasks.values()].map(cloneTask); }
  findByDelegation(delegationId: string, parentIdentity: string): DelegatedTask | undefined { const task = [...this.tasks.values()].find((entry) => entry.delegationId === delegationId && entry.parentIdentity === parentIdentity); return task ? cloneTask(task) : undefined; }
  async createChild(parentSessionId: string, parentPermissions: readonly DelegationPermission[], request: DelegationRequest, metadata: DelegatedTaskMetadata): Promise<DelegatedTask> { const existing = this.findByDelegation(metadata.delegationId, metadata.parentIdentity); if (existing) return existing; const task = await this.create(parentSessionId, [...parentPermissions, "agent.delegate"], request, metadata.context?.delegationDepth ?? 0, true); const updated: DelegatedTask = { ...task, effectivePermissions: task.effectivePermissions, ...metadata, authority: "child", ...(metadata.context ? { context: metadata.context } : {}), version: task.version + 1, updatedAt: new Date().toISOString() }; this.tasks.set(updated.id, updated); await this.persistence?.save(updated); return cloneTask(updated); }
  async recordProjection(parentSessionId: string, request: DelegationRequest, accepted: { readonly delegationId: string; readonly childNodeId: string; readonly childTaskId: string; readonly taskVersion: number; readonly state: DelegatedTaskStatus }, parentIdentity: string): Promise<DelegatedTask> { const existing = this.findByDelegation(accepted.delegationId, parentIdentity); if (existing) return existing; const now = new Date().toISOString(); const task: DelegatedTask = { id: accepted.delegationId, parentSessionId, objective: request.objective, ...(request.context ? { context: request.context } : {}), ...(request.constraints ? { constraints: [...request.constraints] } : {}), ...(request.acceptanceCriteria ? { acceptanceCriteria: [...request.acceptanceCriteria] } : {}), ...(request.restrict ? { restrictions: [...request.restrict] } : {}), ...(request.model ? { requestedModel: request.model } : {}), ...(request.budget ? { budget: request.budget } : {}), effectivePermissions: [], scratchpadNamespace: `remote-${accepted.delegationId}`, status: accepted.state, attempts: [], depth: 0, version: accepted.taskVersion, createdAt: now, updatedAt: now, delegationId: accepted.delegationId, childTaskId: accepted.childTaskId, parentNodeId: parentIdentity, parentIdentity, childNodeId: accepted.childNodeId, authority: "parent-projection", lastSeenAt: now, stale: false }; this.tasks.set(task.id, task); await this.persistence?.save(task); return cloneTask(task); }
  async markProjectionUnavailable(id: string): Promise<DelegatedTask> { const task = this.require(id); const updated = { ...task, stale: true, updatedAt: new Date().toISOString() }; this.tasks.set(id, updated); await this.persistence?.save(updated); return cloneTask(updated); }
  async updateProjection(id: string, snapshot: { readonly status: DelegatedTaskStatus; readonly version: number; readonly result?: DelegatedResult }): Promise<DelegatedTask> { const task = this.require(id); if (task.authority !== "parent-projection" || snapshot.version < task.version) return cloneTask(task); const updated: DelegatedTask = { ...task, status: snapshot.status, version: snapshot.version, ...(snapshot.result ? { remoteResult: snapshot.result } : {}), stale: false, lastSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as DelegatedTask; this.tasks.set(id, updated); await this.persistence?.save(updated); return cloneTask(updated); }
  async prefill(task: DelegatedTask, prefill: ScratchpadPrefill | undefined): Promise<void> {
    if (!prefill) return;
    const entries: [string, readonly string[] | undefined][] = [["parent-context", prefill.context], ["constraints", prefill.constraints], ["hypotheses", prefill.hypotheses], ["relevant-files", prefill.relevantFiles]];
    for (const [key, values] of entries) if (values?.length) await this.scratchpad.write(task.parentSessionId, this.key(task, key), values.map((value) => `${key === "hypotheses" ? "[tentative] " : ""}${value}`).join("\n"));
  }
  async startAttempt(id: string, model: ModelDescriptor): Promise<DelegatedAttempt> {
    const task = this.require(id); if (task.status === "cancelled" || task.status === "completed") throw new Error("Delegated task is not resumable.");
    const attempt: DelegatedAttempt = { id: `attempt-${randomUUID()}`, model, startedAt: new Date().toISOString(), permissions: [...task.effectivePermissions] };
    this.replace({ ...task, status: "running", attempts: [...task.attempts, attempt] }); return { ...attempt, permissions: [...attempt.permissions] };
  }
  async runAttempt(taskId: string, model: ModelDescriptor, execute: DelegatedExecutor): Promise<DelegatedTask> { const attempt = await this.startAttempt(taskId, model); try { const result = await execute({ task: this.require(taskId), attempt, scratchpad: this.scratchpad }); return this.finishAttempt(taskId, attempt.id, "completed", result); } catch (error) { await this.finishAttempt(taskId, attempt.id, "failed", undefined, error instanceof Error ? error.message : "Delegated attempt failed."); throw error; } }
  async finishAttempt(taskId: string, attemptId: string, status: Exclude<DelegatedTaskStatus, "pending" | "running">, result?: DelegatedResult, terminationReason?: string): Promise<DelegatedTask> {
    const task = this.require(taskId); const attempt = task.attempts.find((entry) => entry.id === attemptId); if (!attempt) throw new Error("Delegated attempt was not found.");
    const updatedAttempt: DelegatedAttempt = { ...attempt, completedAt: new Date().toISOString(), ...(terminationReason ? { terminationReason } : {}), ...(result ? { result } : {}) };
    this.replace({ ...task, status, attempts: task.attempts.map((entry) => entry.id === attemptId ? updatedAttempt : entry) }); return cloneTask(this.require(taskId));
  }
  async appendFinding(taskId: string, key: string, content: string): Promise<void> { const task = this.require(taskId); const scratchpadKey = this.key(task, key); const existing = await this.scratchpad.read(task.parentSessionId, scratchpadKey); if (existing) await this.scratchpad.append(task.parentSessionId, scratchpadKey, `\n${content}`); else await this.scratchpad.write(task.parentSessionId, scratchpadKey, content); }
  async snapshot(taskId: string): Promise<{ task: DelegatedTask; scratchpad: readonly { key: string; content: string }[] }> { const task = this.require(taskId); const entries = []; for (const metadata of await this.scratchpad.list(task.parentSessionId)) if (metadata.key.startsWith(`${task.scratchpadNamespace}-`)) { const entry = await this.scratchpad.read(task.parentSessionId, metadata.key); if (entry) entries.push({ key: metadata.key.slice(task.scratchpadNamespace.length + 1), content: entry.content }); } return { task: cloneTask(task), scratchpad: entries }; }
  cancel(taskId: string): DelegatedTask { const task = this.require(taskId); this.replace({ ...task, status: "cancelled" }); return cloneTask(this.require(taskId)); }
  cancelByParent(parentSessionId: string): readonly DelegatedTask[] { const cancelled: DelegatedTask[] = []; for (const task of this.tasks.values()) if (["pending", "running"].includes(task.status) && task.parentSessionId === parentSessionId) cancelled.push(this.cancel(task.id)); return cancelled; }
  private key(task: DelegatedTask, key: string): string { return `${task.scratchpadNamespace}-${key}`; }
  private require(id: string): DelegatedTask { const task = this.tasks.get(id); if (!task) throw new Error(`Delegated task '${id}' was not found.`); return task; }
  private replace(task: DelegatedTask): void { const updated = { ...task, version: (task.version ?? 1) + 1, updatedAt: new Date().toISOString() }; this.tasks.set(task.id, updated); void this.persistence?.save(updated); }
}
function cloneTask(task: DelegatedTask): DelegatedTask { return { ...task, effectivePermissions: [...task.effectivePermissions], attempts: task.attempts.map((attempt) => ({ ...attempt, permissions: [...attempt.permissions] })) }; }
export function delegationPermissionForTool(toolId: string): string { if (toolId.startsWith("filesystem/read") || toolId.startsWith("filesystem/list") || toolId.startsWith("filesystem/stat") || toolId.startsWith("filesystem/search")) return "filesystem.read"; if (toolId.startsWith("filesystem/")) return "filesystem.write"; if (toolId.startsWith("execution/")) return "execution"; if (toolId === "agent/delegate") return "agent.delegate"; return toolId.startsWith("scratchpad/") || toolId.startsWith("artifact/") || toolId.startsWith("task/") ? "task.state" : `tool:${toolId}`; }
export function permissionsForTools(tools: readonly ToolDescriptor[]): readonly DelegationPermission[] { return [...new Set(tools.map((tool) => delegationPermissionForTool((tool as ToolDescriptor & { canonicalId?: string }).canonicalId ?? tool.id)))]; }

export class DelegationOrchestrator {
  constructor(private readonly store: DelegatedTaskStore) {}
  async runAttempt(input: RunDelegatedAttemptInput): Promise<DelegatedAttemptResult> {
    const task = this.store.get(input.taskId); if (!task) throw new Error("Delegated task was not found.");
    const attempt = await this.store.startAttempt(task.id, input.model.descriptor);
    const allowed = input.tools.listTools().filter((tool) => toolAllowed(tool, task.effectivePermissions));
    const policy: ToolAuthorizationPolicy = { authorize: async (request) => task.effectivePermissions.includes(permissionFor(request.invocation.toolId)) ? input.policy.authorize(request) : "deny" };
    const context: ModelContext = { traceId: task.context?.traceId ?? `delegated-${task.id}`, sessionId: task.parentSessionId, executionId: attempt.id, signal: input.signal ?? new AbortController().signal, delegatedTaskId: task.id };
    const control = [{ role: "system" as const, content: "You are a delegated worker operating on a bounded task. Use the task-owned scratchpad as durable handoff state, verify hypotheses, preserve useful findings, do not expand scope, and return a concise result to the parent." }, { role: "system" as const, content: `Delegated task scratchpad namespace: ${task.scratchpadNamespace}. Objective: ${task.objective}${task.constraints?.length ? `\nConstraints: ${task.constraints.join("; ")}` : ""}${task.acceptanceCriteria?.length ? `\nAcceptance criteria: ${task.acceptanceCriteria.join("; ")}` : ""}` }];
    const execution = new AgentOrchestrator(input.model, input.tools, { maxSteps: input.budget?.maxTurns ?? 6, maxToolCalls: input.budget?.maxToolCalls ?? 20 }, { policy, approvalProvider: input.approvalProvider }).create(task.objective, context, allowed, [], control);
    for await (const _event of execution.events()) { /* drain normal AgentExecution lifecycle */ }
    const result = await execution.result();
    const status = result.status === "completed" ? "completed" : result.status === "limit-reached" ? "budget-exhausted" : result.status === "cancelled" || result.status === "timed-out" ? "cancelled" : "failed";
    const delegatedResult = result.text ? { summary: result.text, confidence: status === "completed" ? "high" as const : "low" as const } : undefined;
    const updated = await this.store.finishAttempt(task.id, attempt.id, status, delegatedResult, result.error?.message);
    return { task: updated, attempt: updated.attempts.find((entry) => entry.id === attempt.id)!, ...(delegatedResult ? { result: delegatedResult } : {}), execution };
  }
}
function permissionFor(toolId: string): string { return delegationPermissionForTool(toolId); }
function toolAllowed(tool: ToolDescriptor & { canonicalId?: string }, permissions: readonly string[]): boolean { const canonical = tool.canonicalId ?? tool.id; return permissions.includes(permissionFor(canonical)) || permissionFor(canonical) === "task.state"; }

const requestSchema = z.object({ objective: z.string().min(1), targetNodeId: z.string().min(1).optional(), model: z.string().min(1).optional(), restrict: z.array(z.string().min(1)).optional(), budget: z.object({ maxTurns: z.number().int().positive().optional(), maxToolCalls: z.number().int().positive().optional(), maxTokens: z.number().int().positive().optional() }).optional(), scratchpad: z.object({ context: z.array(z.string()).optional(), constraints: z.array(z.string()).optional(), hypotheses: z.array(z.string()).optional(), relevantFiles: z.array(z.string()).optional() }).optional() }).strict();
export interface RemoteDelegationRunner { (task: DelegatedTask, targetNodeId: string, request: DelegationRequest, context: ToolContext): Promise<ToolResult> }
export class DelegationToolProvider implements ToolProvider {
  readonly providerId = "agent";
  private runAttempt?: DelegatedAttemptRunner;
  private remoteDelegate?: RemoteDelegationRunner;
  constructor(private readonly store: DelegatedTaskStore, private readonly parentPermissions: readonly DelegationPermission[], runAttempt?: DelegatedAttemptRunner, remoteDelegate?: RemoteDelegationRunner) { this.runAttempt = runAttempt; this.remoteDelegate = remoteDelegate; }
  setRemoteDelegate(remoteDelegate: RemoteDelegationRunner): void { this.remoteDelegate = remoteDelegate; }
  setRunner(runAttempt: DelegatedAttemptRunner): void { this.runAttempt = runAttempt; }
  async listTools(_context: ToolContext): Promise<readonly ToolDescriptor[]> { return [{ id: "delegate", name: "agent/delegate", version: "1", description: "Create bounded delegated work with inherited, optionally restricted permissions and task-owned scratchpad state.", inputSchema: { type: "object", required: ["objective"], properties: { objective: { type: "string" }, targetNodeId: { type: "string" }, model: { type: "string" }, restrict: { type: "array", items: { type: "string" } }, budget: { type: "object" }, scratchpad: { type: "object" } } } }]; }
  async invoke(request: ToolInvocation, context: ToolContext): Promise<ToolResult> { const parsed = requestSchema.safeParse(request.input); if (!parsed.success) return { ok: false, error: { code: "VALIDATION_FAILED", message: "Delegation arguments are invalid.", retryable: false } }; try { const task = context.delegatedTaskId ? this.store.get(context.delegatedTaskId) : undefined;
    if (parsed.data.targetNodeId) { if (!this.remoteDelegate || !task || !canDelegate(task.effectivePermissions)) return { ok: false, error: { code: "POLICY_VIOLATION", message: "Recursive delegation is unavailable for this task.", retryable: false } }; return this.remoteDelegate(task, parsed.data.targetNodeId, parsed.data, context); }
    const localTask = await this.store.create(context.sessionId, this.parentPermissions, parsed.data); if (!this.runAttempt) return { ok: true, output: { taskId: localTask.id, status: localTask.status, objective: localTask.objective, permissions: localTask.effectivePermissions, scratchpadNamespace: localTask.scratchpadNamespace } }; const run = await this.runAttempt(localTask); const current = run.task; return { ok: true, output: { taskId: current.id, attemptId: run.attempt.id, status: current.status, model: { id: run.attempt.model.id, version: run.attempt.model.version }, summary: run.result?.summary ?? "Delegated attempt finished without a summary.", ...(run.result?.findings ? { findings: run.result.findings } : {}), ...(run.result?.evidence ? { evidence: run.result.evidence } : {}), ...(run.result?.unresolvedQuestions ? { unresolvedQuestions: run.result.unresolvedQuestions } : {}), ...(run.result?.confidence ? { confidence: run.result.confidence } : {}) } }; } catch (error) { return { ok: false, error: { code: "POLICY_VIOLATION", message: error instanceof Error ? error.message : "Delegation failed.", retryable: false } }; } }
}
