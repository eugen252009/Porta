import { randomUUID } from "node:crypto";
import { permissionsForTools, type DelegatedResult, type DelegatedTask, type DelegationRequest, type DelegationContext, type DelegatedTaskStatus, type DelegatedTaskStore } from "./delegation.js";
import type { ApprovalProvider, ModelProvider, ToolAuthorizationPolicy } from "./contracts.js";
import type { ToolRouter } from "./tools.js";
import type { TargetRegistry } from "./target.js";
import type { RemoteApplicationGateway } from "./remote-application.js";
import type { DelegatedTaskAccepted, DelegatedTaskProtocol, DelegatedTaskRequest, DelegatedTaskSnapshot } from "./target-transport.js";

export type Principal =
  | { readonly kind: "human"; readonly identity: string }
  | { readonly kind: "node"; readonly identity: string }
  | { readonly kind: "local"; readonly identity: string };

export interface DelegatedTaskApplicationContext {
  readonly identity: string;
  readonly delegations: DelegatedTaskStore;
  readonly toolRouter: ToolRouter;
  resolveModel(requested?: string): Promise<ModelProvider>;
  readonly delegationOrchestrator: import("./delegation.js").DelegationOrchestrator;
  readonly authorizationPolicy: ToolAuthorizationPolicy;
  readonly pendingApprovals: ApprovalProvider;
  readonly executionTargets?: TargetRegistry;
  readonly maxDelegationDepth?: number;
}

/** Canonical delegated-task application semantics shared by Web and node adapters. */
export class DelegatedTaskApplicationService {
  private readonly running = new Map<string, AbortController>();
  constructor(private readonly context: DelegatedTaskApplicationContext, private readonly nodeId: string) {}

  async delegateChild(task: DelegatedTask, targetNodeId: string, request: DelegationRequest): Promise<import("./contracts.js").ToolResult> {
    const target = this.context.executionTargets?.resolve(targetNodeId); if (!target) return { ok: false, error: { code: "CAPABILITY_UNAVAILABLE", message: `Target node '${targetNodeId}' is not known.`, retryable: false } };
    const remote = target.application as RemoteApplicationGateway | undefined; if (!remote) return { ok: false, error: { code: "CAPABILITY_UNAVAILABLE", message: `Target node '${targetNodeId}' does not expose application delegation.`, retryable: false } };
    const description = await remote.describe(); if (!description.capabilities.includes("delegatedTasks")) return { ok: false, error: { code: "CAPABILITY_UNAVAILABLE", message: `Target node '${targetNodeId}' does not support delegated tasks.`, retryable: false } };
    const current = task.context ?? { originNodeId: this.context.identity, parentNodeId: this.context.identity, currentNodeId: this.context.identity, traceId: `delegation-${task.id}`, delegationDepth: 0, maxDelegationDepth: this.context.maxDelegationDepth ?? 2, visitedNodeIds: [this.context.identity] };
    if (current.delegationDepth >= current.maxDelegationDepth) return { ok: false, error: { code: "AUTHORIZATION_DENIED", message: "Delegation depth limit reached.", retryable: false } };
    if (current.visitedNodeIds.includes(description.nodeIdentity)) return { ok: false, error: { code: "AUTHORIZATION_DENIED", message: `Target node '${targetNodeId}' is already in the delegation chain.`, retryable: false } };
    const knownPermissions = ["filesystem.read", "filesystem.write", "execution", "agent.delegate", "task.state"];
    const restrict = knownPermissions.filter((permission) => !task.effectivePermissions.includes(permission));
    const childContext: DelegationContext = { originNodeId: current.originNodeId, parentNodeId: this.context.identity, currentNodeId: description.nodeIdentity, traceId: current.traceId, delegationDepth: current.delegationDepth + 1, maxDelegationDepth: Math.min(current.maxDelegationDepth, this.context.maxDelegationDepth ?? current.maxDelegationDepth), visitedNodeIds: [...current.visitedNodeIds, description.nodeIdentity] };
    const remoteRequest = { version: 1 as const, type: "porta-delegated-task" as const, delegationId: `delegation-${randomUUID()}`, objective: request.objective, ...(request.constraints ? { constraints: request.constraints } : {}), ...(request.acceptanceCriteria ? { acceptanceCriteria: request.acceptanceCriteria } : {}), ...(request.model ? { requestedModel: request.model } : {}), ...(restrict.length ? { permissions: restrict } : {}), ...(request.budget ? { budget: request.budget } : {}), context: childContext };
    let accepted: DelegatedTaskAccepted;
    try { accepted = await remote.createDelegatedTask(remoteRequest); } catch (error) { return { ok: false, error: { code: "CAPABILITY_UNAVAILABLE", message: error instanceof Error ? error.message : "Child node is unavailable.", retryable: true } }; }
    await this.context.delegations.recordProjection(task.id, { ...request, context: childContext }, { ...accepted, state: accepted.state as DelegatedTaskStatus }, this.context.identity);
    for (let attempt = 0; attempt < 50; attempt++) { try { const snapshot = await remote.getDelegatedTask(accepted.childTaskId, accepted.delegationId); await this.context.delegations.updateProjection(accepted.delegationId, { status: snapshot.state as DelegatedTaskStatus, version: snapshot.taskVersion, ...(snapshot.resultSummary ? { result: { summary: snapshot.resultSummary } } : {}) }); if (["completed", "failed", "cancelled", "blocked", "budget-exhausted", "tool-unavailable"].includes(snapshot.state)) return snapshot.state === "completed" ? { ok: true, output: { childTaskId: accepted.childTaskId, state: snapshot.state, summary: snapshot.resultSummary ?? "Child task completed." } } : { ok: false, error: { code: "POLICY_VIOLATION", message: snapshot.resultSummary ?? `Child task ended in ${snapshot.state}.`, retryable: false } }; } catch { await this.context.delegations.markProjectionUnavailable(accepted.delegationId); return { ok: false, error: { code: "CAPABILITY_UNAVAILABLE", message: "Child node became unavailable.", retryable: true } }; } await new Promise((resolve) => setTimeout(resolve, 20)); }
    return { ok: false, error: { code: "CAPABILITY_UNAVAILABLE", message: "Child task did not become observable before the deadline.", retryable: true } };
  }

  async createForNode(request: DelegatedTaskRequest, parentIdentity: string): Promise<DelegatedTaskAccepted> {
    return this.create(request, { kind: "node", identity: parentIdentity });
  }

  async getForNode(childTaskId: string, delegationId: string, parentIdentity: string): Promise<DelegatedTaskSnapshot> {
    return this.get(childTaskId, delegationId, { kind: "node", identity: parentIdentity });
  }

  async cancelForNode(childTaskId: string, delegationId: string, parentIdentity: string): Promise<DelegatedTaskSnapshot> {
    return this.cancel(childTaskId, delegationId, { kind: "node", identity: parentIdentity });
  }

  async create(request: DelegatedTaskRequest, principal: Principal): Promise<DelegatedTaskAccepted> {
    if (principal.kind !== "node" && principal.kind !== "local") throw new Error("DELEGATION_PRINCIPAL_FORBIDDEN");
    validateRequest(request);
    const context = this.normalizeContext(request.context, principal.identity);
    const existing = this.context.delegations.findByDelegation(request.delegationId, principal.identity);
    if (existing) {
      if (!sameRequest(existing, request)) throw new Error("DELEGATION_ID_CONFLICT");
      return accepted(this.nodeId, existing);
    }
    const model = await this.context.resolveModel(request.requestedModel);
    const permissions = permissionsForTools(this.context.toolRouter.listTools());
    const task = await this.context.delegations.createChild(`remote-parent:${principal.identity}`, permissions, toDelegationRequest(request), { delegationId: request.delegationId, parentNodeId: principal.identity, parentIdentity: principal.identity, childNodeId: this.nodeId, authority: "child", context });
    void this.run(task.id, model);
    return accepted(this.nodeId, task);
  }

  private normalizeContext(incoming: DelegationContext | undefined, parentIdentity: string): DelegationContext {
    const localMax = this.context.maxDelegationDepth ?? 2; if (!incoming) return { originNodeId: parentIdentity, parentNodeId: parentIdentity, currentNodeId: this.nodeId, traceId: `trace-${randomUUID()}`, delegationDepth: 1, maxDelegationDepth: localMax, visitedNodeIds: [parentIdentity, this.nodeId] };
    if (incoming.currentNodeId !== this.nodeId || !incoming.visitedNodeIds.includes(parentIdentity) || incoming.visitedNodeIds.at(-1) !== this.nodeId || new Set(incoming.visitedNodeIds).size !== incoming.visitedNodeIds.length) throw new Error("DELEGATION_CONTEXT_INVALID");
    return { ...incoming, maxDelegationDepth: Math.min(incoming.maxDelegationDepth, localMax) };
  }

  async get(childTaskId: string, delegationId: string, principal: Principal): Promise<DelegatedTaskSnapshot> {
    const task = this.authorizedTask(childTaskId, delegationId, principal);
    return snapshot(this.nodeId, task);
  }

  async cancel(childTaskId: string, delegationId: string, principal: Principal): Promise<DelegatedTaskSnapshot> {
    const task = this.authorizedTask(childTaskId, delegationId, principal);
    this.running.get(childTaskId)?.abort();
    await this.cancelOwnedChildren(task);
    const cancelled = task.status === "completed" || task.status === "cancelled" ? task : this.context.delegations.cancel(childTaskId);
    return snapshot(this.nodeId, cancelled);
  }

  list(principal: Principal): readonly DelegatedTask[] {
    return this.context.delegations.list().filter((task) => principal.kind !== "node" || task.parentIdentity === principal.identity);
  }

  async recordProjection(request: DelegationRequest, accepted: DelegatedTaskAccepted, parentIdentity: string, childNodeId: string): Promise<DelegatedTask> { return this.context.delegations.recordProjection(`remote-child:${childNodeId}`, request, { ...accepted, state: accepted.state as DelegatedTaskStatus }, parentIdentity); }
  async updateProjection(id: string, snapshot: { readonly status: DelegatedTaskStatus; readonly version: number; readonly result?: DelegatedResult }): Promise<DelegatedTask> { return this.context.delegations.updateProjection(id, snapshot); }
  async markProjectionUnavailable(id: string): Promise<DelegatedTask> { return this.context.delegations.markProjectionUnavailable(id); }

  getForPrincipal(id: string, principal: Principal): DelegatedTask | undefined {
    const task = this.context.delegations.get(id);
    if (!task || (principal.kind === "node" && task.parentIdentity !== principal.identity)) return undefined;
    return task;
  }

  async cancelForPrincipal(id: string, principal: Principal): Promise<DelegatedTask> {
    const task = this.getForPrincipal(id, principal);
    if (!task) throw new Error("DELEGATED_TASK_NOT_FOUND");
    await this.cancelOwnedChildren(task);
    return this.context.delegations.cancel(id);
  }

  private async cancelOwnedChildren(task: DelegatedTask): Promise<void> {
    for (const child of this.context.delegations.list().filter((entry) => entry.authority === "parent-projection" && entry.parentSessionId === task.id && entry.childTaskId && entry.childNodeId)) {
      const target = this.context.executionTargets?.resolve(child.childNodeId!); const remote = target?.application as RemoteApplicationGateway | undefined;
      if (!remote) continue;
      try { await remote.cancelDelegatedTask(child.childTaskId!, child.delegationId!); } catch { await this.context.delegations.markProjectionUnavailable(child.id); }
    }
  }

  private authorizedTask(childTaskId: string, delegationId: string, principal: Principal): DelegatedTask {
    const task = this.context.delegations.get(childTaskId);
    if (!task || task.authority !== "child" || task.delegationId !== delegationId || (principal.kind === "node" && task.parentIdentity !== principal.identity)) throw new Error("DELEGATED_TASK_NOT_FOUND");
    return task;
  }

  private async run(taskId: string, model: ModelProvider): Promise<void> {
    const controller = new AbortController(); this.running.set(taskId, controller);
    try { await this.context.delegationOrchestrator.runAttempt({ taskId, model, tools: this.context.toolRouter, policy: this.context.authorizationPolicy, approvalProvider: this.context.pendingApprovals, signal: controller.signal }); }
    catch { /* The authoritative failure is persisted by DelegationOrchestrator. */ }
    finally { this.running.delete(taskId); }
  }
}

/** Thin node-protocol adapter over the canonical application service. */
export class NodeDelegationService implements DelegatedTaskProtocol {
  constructor(private readonly application: DelegatedTaskApplicationService) {}
  create(request: DelegatedTaskRequest, parentIdentity: string): Promise<DelegatedTaskAccepted> { return this.application.createForNode(request, parentIdentity); }
  get(childTaskId: string, delegationId: string, parentIdentity: string): Promise<DelegatedTaskSnapshot> { return this.application.getForNode(childTaskId, delegationId, parentIdentity); }
  cancel(childTaskId: string, delegationId: string, parentIdentity: string): Promise<DelegatedTaskSnapshot> { return this.application.cancelForNode(childTaskId, delegationId, parentIdentity); }
}

export class NodeDelegationClient {
  constructor(private readonly application: { readonly identity: { readonly public: { readonly identity: string } }; readonly delegatedTasks: DelegatedTaskApplicationService }, private readonly transport: Pick<RemoteApplicationGateway, "createDelegatedTask" | "getDelegatedTask" | "cancelDelegatedTask">, private readonly childNodeId: string, private readonly parentIdentity = application.identity.public.identity) {}
  async create(request: DelegatedTaskRequest): Promise<DelegatedTaskAccepted> { const accepted = await this.transport.createDelegatedTask(request); await this.application.delegatedTasks.recordProjection(toDelegationRequest(request), accepted, this.parentIdentity, this.childNodeId); return accepted; }
  async get(accepted: Pick<DelegatedTaskAccepted, "delegationId" | "childTaskId">): Promise<DelegatedTaskSnapshot> { let snapshot: DelegatedTaskSnapshot; try { snapshot = await this.transport.getDelegatedTask(accepted.childTaskId, accepted.delegationId); } catch (error) { await this.application.delegatedTasks.markProjectionUnavailable(accepted.delegationId); throw error; } await this.application.delegatedTasks.updateProjection(accepted.delegationId, { status: snapshot.state as DelegatedTaskStatus, version: snapshot.taskVersion, ...(snapshot.resultSummary ? { result: { summary: snapshot.resultSummary } } : {}) }); return snapshot; }
  async cancel(accepted: Pick<DelegatedTaskAccepted, "delegationId" | "childTaskId">): Promise<DelegatedTaskSnapshot> { const snapshot = await this.transport.cancelDelegatedTask(accepted.childTaskId, accepted.delegationId); await this.application.delegatedTasks.updateProjection(accepted.delegationId, { status: snapshot.state as DelegatedTaskStatus, version: snapshot.taskVersion, ...(snapshot.resultSummary ? { result: { summary: snapshot.resultSummary } } : {}) }); return snapshot; }
}

function toDelegationRequest(request: DelegatedTaskRequest): DelegationRequest { return { objective: request.objective, ...(request.constraints ? { constraints: request.constraints } : {}), ...(request.acceptanceCriteria ? { acceptanceCriteria: request.acceptanceCriteria } : {}), ...(request.requestedModel ? { model: request.requestedModel } : {}), ...(request.permissions ? { restrict: request.permissions } : {}), ...(request.budget ? { budget: request.budget } : {}) }; }
function validateRequest(request: DelegatedTaskRequest): void { if (request.version !== 1 || request.type !== "porta-delegated-task" || !request.delegationId.trim() || !request.objective.trim()) throw new Error("DELEGATED_TASK_INVALID"); }
function sameRequest(task: DelegatedTask, request: DelegatedTaskRequest): boolean { return task.objective === request.objective && task.requestedModel === request.requestedModel && JSON.stringify(task.constraints ?? []) === JSON.stringify(request.constraints ?? []) && JSON.stringify(task.acceptanceCriteria ?? []) === JSON.stringify(request.acceptanceCriteria ?? []) && JSON.stringify(task.budget ?? {}) === JSON.stringify(request.budget ?? {}) && JSON.stringify(task.restrictions ?? []) === JSON.stringify(request.permissions ?? []); }
function accepted(nodeId: string, task: DelegatedTask): DelegatedTaskAccepted { return { version: 1, type: "porta-delegated-task-accepted", delegationId: task.delegationId!, childNodeId: nodeId, childTaskId: task.id, taskVersion: task.version, state: task.status }; }
function snapshot(nodeId: string, task: DelegatedTask): DelegatedTaskSnapshot { const result: DelegatedResult | undefined = task.remoteResult ?? task.attempts.at(-1)?.result; return { version: 1, type: "porta-delegated-task-state", delegationId: task.delegationId!, childNodeId: nodeId, childTaskId: task.id, taskVersion: task.version, state: task.status, ...(result?.summary ? { resultSummary: result.summary } : {}) }; }
