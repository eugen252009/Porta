import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attentionFor } from "./attention.js";
import type { PortaApplication } from "./porta-application.js";
import type { Principal } from "./node-delegation.js";
import type { DelegatedTaskRequest, DelegatedTaskAccepted, DelegatedTaskSnapshot, HttpTargetTransport, NodeApplicationDescription, NodeApplicationProtocol, NodeSessionSnapshot, NodeTaskSummary, NodeApprovalSnapshot, NodeCancellationResult, TargetTransportError } from "./target-transport.js";
import { TargetTransportError as TransportError } from "./target-transport.js";

export type RemoteApplicationFailureKind = "unavailable" | "denied" | "unsupported" | "failed";
export class RemoteApplicationError extends Error { constructor(readonly kind: RemoteApplicationFailureKind, message: string, readonly cause?: unknown) { super(message); this.name = "RemoteApplicationError"; } }

export interface RemoteApplicationTransport extends Pick<HttpTargetTransport, "createDelegatedTask" | "getDelegatedTask" | "cancelDelegatedTask" | "describeApplication" | "listApplicationModels" | "createApplicationSession" | "listApplicationTasks" | "getApplicationTask" | "runApplicationTask" | "releaseApplicationTask" | "recoverApplicationTask" | "interveneApplicationTask" | "listApplicationApprovals" | "resolveApplicationApproval" | "cancelApplicationSession" | "listApplicationSessions" | "getApplicationSession" | "submitApplicationSession" | "listApplicationDelegatedTasks"> {}

/** Remote client for application capabilities. It owns transport concerns but no remote state. */
export class RemoteApplicationGateway {
  constructor(private readonly transport: RemoteApplicationTransport) {}
  async describe(): Promise<NodeApplicationDescription> { return this.call(() => this.transport.describeApplication()); }
  async models(): Promise<readonly unknown[]> { return this.call(() => this.transport.listApplicationModels()); }
  async createSession(input: { readonly sessionId?: string; readonly target?: string; readonly model?: { readonly provider: string; readonly model: string } }): Promise<NodeSessionSnapshot> { return this.call(() => this.transport.createApplicationSession(input)); }
  async listTasks(): Promise<readonly NodeTaskSummary[]> { return this.call(() => this.transport.listApplicationTasks()); }
  async getTask(sessionId: string): Promise<NodeTaskSummary | undefined> { return this.call(() => this.transport.getApplicationTask(sessionId)); }
  async runTask(taskId: string): Promise<NodeTaskSummary | undefined> { return this.call(() => this.transport.runApplicationTask(taskId)); }
  async releaseTask(taskId: string): Promise<NodeTaskSummary | undefined> { return this.call(() => this.transport.releaseApplicationTask(taskId)); }
  async recoverTask(taskId: string): Promise<NodeTaskSummary | undefined> { return this.call(() => this.transport.recoverApplicationTask(taskId)); }
  async interveneTask(taskId: string, version: number, action: import("./task.js").DevelopmentInterventionAction, input?: string, message?: string): Promise<NodeTaskSummary | undefined> { return this.call(() => this.transport.interveneApplicationTask(taskId, version, action, input, message)); }
  async listApprovals(): Promise<readonly NodeApprovalSnapshot[]> { return this.call(() => this.transport.listApplicationApprovals()); }
  async resolveApproval(approvalId: string, decision: "approve" | "deny", reason?: string): Promise<import("./contracts.js").ApprovalResolvedEvent> { return this.call(() => this.transport.resolveApplicationApproval(approvalId, decision, reason)); }
  async cancelSession(sessionId: string): Promise<NodeCancellationResult> { return this.call(() => this.transport.cancelApplicationSession(sessionId)); }
  async listSessions(): Promise<readonly NodeSessionSnapshot[]> { return this.call(() => this.transport.listApplicationSessions()); }
  async getSession(sessionId: string): Promise<NodeSessionSnapshot | undefined> { return this.call(() => this.transport.getApplicationSession(sessionId)); }
  async submitSession(sessionId: string, input: string): Promise<readonly import("./contracts.js").KernelEvent[]> { return this.call(() => this.transport.submitApplicationSession(sessionId, input)); }
  async listDelegatedTasks(): Promise<readonly unknown[]> { return this.call(() => this.transport.listApplicationDelegatedTasks()); }
  async createDelegatedTask(request: DelegatedTaskRequest): Promise<DelegatedTaskAccepted> { return this.call(() => this.transport.createDelegatedTask(request)); }
  async getDelegatedTask(childTaskId: string, delegationId: string): Promise<DelegatedTaskSnapshot> { return this.call(() => this.transport.getDelegatedTask(childTaskId, delegationId)); }
  async cancelDelegatedTask(childTaskId: string, delegationId: string): Promise<DelegatedTaskSnapshot> { return this.call(() => this.transport.cancelDelegatedTask(childTaskId, delegationId)); }
  private async call<T>(operation: () => Promise<T>): Promise<T> { try { return await operation(); } catch (error) { throw classifyRemoteError(error); } }
}

/** Server-side adapter: authenticated node requests reach the existing application services. */
export function createNodeApplicationProtocol(application: PortaApplication): NodeApplicationProtocol {
  const ownershipPath = join(application.identity.directory, "application-session-owners.json");
  const sessionOwners = new Map<string, string>();
  if (existsSync(ownershipPath)) {
    try { for (const [sessionId, owner] of Object.entries(JSON.parse(readFileSync(ownershipPath, "utf8")) as Record<string, string>)) if (typeof owner === "string" && owner) sessionOwners.set(sessionId, owner); } catch { /* fail closed: unreadable ownership state grants no access */ }
  }
  const persistOwnership = () => writeFileSync(ownershipPath, JSON.stringify(Object.fromEntries(sessionOwners), null, 2) + "\n", { mode: 0o600 });
  return {
    async describe() { const tasks = await application.tasks.list(); const pendingApprovals = application.pendingApprovals.pendingRequests(); return { version: 1, nodeIdentity: application.identity.public.identity, capabilities: ["delegatedTasks", "models", "sessions", "tasks", "approvals", "sessions.cancel", ...(application.localTarget ? ["primitiveExecution"] : [])], attentionCount: pendingApprovals.length + tasks.filter((task) => task.development?.attention || task.status === "failed").length, activeTaskCount: tasks.filter((task) => task.status === "active" || task.status === "blocked").length }; },
    async models() { return application.modelCatalog(); },
    async createSession(input, principalIdentity) {
      if (input.sessionId && sessionOwners.get(input.sessionId) !== principalIdentity) throw new Error("APPLICATION_ACCESS_DENIED");
      if (input.model && !input.sessionId) await application.resolveModel(`${input.model.provider}/${input.model.model}`);
      const events = []; for await (const event of application.gateway.execute({ type: "CreateSession", ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.target ? { target: input.target } : {}), ...(input.model && !input.sessionId ? { model: input.model } : {}) })) events.push(event);
      const created = events.find((event) => event.type === "SessionCreated"); if (!created || created.type !== "SessionCreated") throw new Error(input.sessionId ? "SESSION_NOT_FOUND" : "SESSION_CREATE_FAILED");
      sessionOwners.set(created.sessionId, principalIdentity); persistOwnership(); const session = await application.conversations.getSession(created.sessionId); if (!session) throw new Error("SESSION_CREATE_FAILED"); return sessionSnapshot(session);
    },
    async listTasks(principalIdentity) { const ownedSessions = new Set([...sessionOwners.entries()].filter(([, owner]) => owner === principalIdentity).map(([sessionId]) => sessionId)); return (await application.tasks.list()).filter((task) => ownedSessions.has(task.sessionId)).map(taskSnapshot); },
    async getTask(sessionId, principalIdentity) { assertOwned(sessionOwners, sessionId, principalIdentity); const task = await application.tasks.get(sessionId); return task ? taskSnapshot(task) : undefined; },
    async runTask(taskId, principalIdentity) { return taskAction(application, sessionOwners, taskId, principalIdentity, "run"); },
    async releaseTask(taskId, principalIdentity) { return taskAction(application, sessionOwners, taskId, principalIdentity, "release"); },
    async recoverTask(taskId, principalIdentity) { return taskAction(application, sessionOwners, taskId, principalIdentity, "recover"); },
    async interveneTask(taskId, version, action, input, message, principalIdentity) { const task = await ownedTask(application, sessionOwners, taskId, principalIdentity); if (!task || !application.developmentRunner) return undefined; const updated = await application.developmentRunner.intervene(task.sessionId, version, action, input, message); if (action === "approve" || action === "provide_input" || action === "resume") void application.developmentRunner.wake(task.sessionId); return taskSnapshot(updated); },
    async listApprovals(principalIdentity) { return application.pendingApprovals.pendingRequests().filter((approval) => sessionOwners.get(approval.sessionId) === principalIdentity).map((approval) => ({ ...approval, status: "pending" as const })); },
    async resolveApproval(approvalId, decision, reason, principalIdentity) { const approval = application.pendingApprovals.pendingRequests().find((entry) => entry.approvalId === approvalId); if (!approval || sessionOwners.get(approval.sessionId) !== principalIdentity) throw new Error("APPLICATION_ACCESS_DENIED"); const events = []; for await (const event of application.gateway.execute({ type: "ResolveApproval", approvalId, decision, ...(reason ? { reason } : {}) })) events.push(event); const resolved = events.find((event): event is import("./contracts.js").ApprovalResolvedEvent => event.type === "ApprovalResolved"); if (!resolved) throw new Error("APPROVAL_RESOLUTION_FAILED"); return resolved; },
    async cancelSession(sessionId, principalIdentity) { assertOwned(sessionOwners, sessionId, principalIdentity); const task = await application.tasks.get(sessionId); const wasActive = application.gateway.hasActiveExecution(sessionId) || task?.status === "active" || task?.status === "blocked"; for await (const _event of application.gateway.execute({ type: "CancelExecution", sessionId })) {} if (task && (task.status === "active" || task.status === "blocked")) await application.tasks.update(sessionId, task.id, task.version, { type: "set_status", status: "cancelled" }); return { sessionId, status: wasActive ? "cancelled" as const : "not_running" as const }; },
    async listSessions(principalIdentity) { const sessions = []; for (const sessionId of application.conversations.openSessionIds()) { if (sessionOwners.get(sessionId) !== principalIdentity) continue; const session = await application.conversations.getSession(sessionId); if (session) sessions.push(await sessionSnapshot(session)); } return sessions; },
    async getSession(sessionId, principalIdentity) { if (sessionOwners.get(sessionId) !== principalIdentity) throw new Error("APPLICATION_ACCESS_DENIED"); const session = await application.conversations.getSession(sessionId); return session ? sessionSnapshot(session) : undefined; },
    async submitSession(sessionId, input, principalIdentity) { if (sessionOwners.get(sessionId) !== principalIdentity) throw new Error("APPLICATION_ACCESS_DENIED"); const events = []; for await (const event of application.gateway.execute({ type: "SubmitInput", sessionId, input })) events.push(event); return events; },
    async listDelegatedTasks(principalIdentity) { return application.delegatedTasks.list({ kind: "node", identity: principalIdentity }); },
  };
}

function assertOwned(owners: ReadonlyMap<string, string>, sessionId: string, principalIdentity: string): void { if (owners.get(sessionId) !== principalIdentity) throw new Error("APPLICATION_ACCESS_DENIED"); }
async function ownedTask(application: PortaApplication, owners: ReadonlyMap<string, string>, taskId: string, principalIdentity: string): Promise<import("./task.js").Task | undefined> { const task = (await application.tasks.list()).find((entry) => entry.id === taskId); if (task) assertOwned(owners, task.sessionId, principalIdentity); return task; }
async function taskAction(application: PortaApplication, owners: ReadonlyMap<string, string>, taskId: string, principalIdentity: string, action: "run" | "release" | "recover"): Promise<NodeTaskSummary | undefined> { const task = await ownedTask(application, owners, taskId, principalIdentity); if (!task || !application.developmentRunner) return undefined; const updated = action === "release" ? await application.developmentRunner.release(task.sessionId) : action === "recover" ? await application.developmentRunner.recover(task.sessionId) : (application.developmentRunner.wake(task.sessionId), await application.tasks.get(task.sessionId)); return updated ? taskSnapshot(updated) : undefined; }
function taskSnapshot(task: import("./task.js").Task): NodeTaskSummary { return { id: task.id, sessionId: task.sessionId, status: task.status, objective: task.objective.slice(0, 160), updatedAt: task.updatedAt, createdAt: task.createdAt, version: task.version, ...(task.development ? { phase: task.development.phase, currentAction: task.development.currentAction, pendingIntervention: task.development.pendingIntervention, development: task.development, attention: attentionFor({ status: task.status, ...(task.development.attention ? { reason: task.development.attention.reason } : {}) }) } : { attention: attentionFor({ status: task.status }) }) }; }
async function sessionSnapshot(session: { id: string; state: "open" | "closed"; createdAt: string; target?: string; model?: { provider: string; model: string }; history?: readonly import("./contracts.js").ModelMessage[] }): Promise<NodeSessionSnapshot> { return { id: session.id, state: session.state, createdAt: session.createdAt, ...(session.target ? { target: session.target } : {}), ...(session.model ? { model: session.model } : {}), ...(session.history?.length ? { history: session.history } : {}) }; }
function classifyRemoteError(error: unknown): RemoteApplicationError {
  if (error instanceof RemoteApplicationError) return error;
  if (error instanceof TransportError) return new RemoteApplicationError(error.status === 401 || error.status === 403 ? "denied" : error.status === 404 ? "unsupported" : "failed", error.message, error);
  if (error instanceof Error && /authentication|unauthorized|forbidden|401|403/i.test(error.message)) return new RemoteApplicationError("denied", error.message, error);
  if (error instanceof Error && /session_not_found|not found/i.test(error.message)) return new RemoteApplicationError("unsupported", error.message, error);
  if (error instanceof TypeError || (error instanceof Error && /fetch|network|connect|socket|econnrefused|timed out/i.test(error.message))) return new RemoteApplicationError("unavailable", error instanceof Error ? error.message : "Remote node is unavailable.", error);
  return new RemoteApplicationError("failed", error instanceof Error ? error.message : "Remote application operation failed.", error);
}
