import type { PortaApplication } from "./porta-application.js";
import type { Principal } from "./node-delegation.js";
import type { DelegatedTaskRequest, DelegatedTaskAccepted, DelegatedTaskSnapshot, HttpTargetTransport, NodeApplicationDescription, NodeApplicationProtocol, NodeSessionSnapshot, NodeTaskSummary, TargetTransportError } from "./target-transport.js";
import { TargetTransportError as TransportError } from "./target-transport.js";

export type RemoteApplicationFailureKind = "unavailable" | "denied" | "unsupported" | "failed";
export class RemoteApplicationError extends Error { constructor(readonly kind: RemoteApplicationFailureKind, message: string, readonly cause?: unknown) { super(message); this.name = "RemoteApplicationError"; } }

export interface RemoteApplicationTransport extends Pick<HttpTargetTransport, "createDelegatedTask" | "getDelegatedTask" | "cancelDelegatedTask" | "describeApplication" | "listApplicationModels" | "createApplicationSession" | "listApplicationTasks" | "listApplicationSessions" | "getApplicationSession" | "submitApplicationSession" | "listApplicationDelegatedTasks"> {}

/** Remote client for application capabilities. It owns transport concerns but no remote state. */
export class RemoteApplicationGateway {
  constructor(private readonly transport: RemoteApplicationTransport) {}
  async describe(): Promise<NodeApplicationDescription> { return this.call(() => this.transport.describeApplication()); }
  async models(): Promise<readonly unknown[]> { return this.call(() => this.transport.listApplicationModels()); }
  async createSession(input: { readonly sessionId?: string; readonly target?: string; readonly model?: { readonly provider: string; readonly model: string } }): Promise<NodeSessionSnapshot> { return this.call(() => this.transport.createApplicationSession(input)); }
  async listTasks(): Promise<readonly NodeTaskSummary[]> { return this.call(() => this.transport.listApplicationTasks()); }
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
  const sessionOwners = new Map<string, string>();
  return {
    async describe() { return { version: 1, nodeIdentity: application.identity.public.identity, capabilities: ["delegatedTasks", "models", "sessions", ...(application.localTarget ? ["primitiveExecution"] : [])], attentionCount: application.pendingApprovals.pendingRequests().length, activeTaskCount: (await application.tasks.list()).filter((task) => task.status === "active" || task.status === "blocked").length }; },
    async models() { return application.modelCatalog(); },
    async createSession(input, principalIdentity) {
      if (input.sessionId && sessionOwners.get(input.sessionId) !== principalIdentity) throw new Error("APPLICATION_ACCESS_DENIED");
      if (input.model && !input.sessionId) await application.resolveModel(`${input.model.provider}/${input.model.model}`);
      const events = []; for await (const event of application.gateway.execute({ type: "CreateSession", ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.target ? { target: input.target } : {}), ...(input.model && !input.sessionId ? { model: input.model } : {}) })) events.push(event);
      const created = events.find((event) => event.type === "SessionCreated"); if (!created || created.type !== "SessionCreated") throw new Error(input.sessionId ? "SESSION_NOT_FOUND" : "SESSION_CREATE_FAILED");
      sessionOwners.set(created.sessionId, principalIdentity); const session = await application.conversations.getSession(created.sessionId); if (!session) throw new Error("SESSION_CREATE_FAILED"); return sessionSnapshot(session);
    },
    async listTasks(principalIdentity) { const ownedSessions = new Set([...sessionOwners.entries()].filter(([, owner]) => owner === principalIdentity).map(([sessionId]) => sessionId)); return (await application.tasks.list()).filter((task) => ownedSessions.has(task.sessionId)).map((task) => ({ id: task.id, sessionId: task.sessionId, status: task.status, objective: task.objective.slice(0, 160), updatedAt: task.updatedAt })); },
    async listSessions(principalIdentity) { const sessions = []; for (const sessionId of application.conversations.openSessionIds()) { if (sessionOwners.get(sessionId) !== principalIdentity) continue; const session = await application.conversations.getSession(sessionId); if (session) sessions.push(sessionSnapshot(session)); } return sessions; },
    async getSession(sessionId, principalIdentity) { if (sessionOwners.get(sessionId) !== principalIdentity) throw new Error("APPLICATION_ACCESS_DENIED"); const session = await application.conversations.getSession(sessionId); return session ? sessionSnapshot(session) : undefined; },
    async submitSession(sessionId, input, principalIdentity) { if (sessionOwners.get(sessionId) !== principalIdentity) throw new Error("APPLICATION_ACCESS_DENIED"); const events = []; for await (const event of application.gateway.execute({ type: "SubmitInput", sessionId, input })) events.push(event); return events; },
    async listDelegatedTasks(principalIdentity) { return application.delegatedTasks.list({ kind: "node", identity: principalIdentity }); },
  };
}

function sessionSnapshot(session: { id: string; state: "open" | "closed"; createdAt: string; target?: string; model?: { provider: string; model: string } }): NodeSessionSnapshot { return { id: session.id, state: session.state, createdAt: session.createdAt, ...(session.target ? { target: session.target } : {}), ...(session.model ? { model: session.model } : {}) }; }
function classifyRemoteError(error: unknown): RemoteApplicationError {
  if (error instanceof RemoteApplicationError) return error;
  if (error instanceof TransportError) return new RemoteApplicationError(error.status === 401 || error.status === 403 ? "denied" : error.status === 404 ? "unsupported" : "failed", error.message, error);
  if (error instanceof Error && /authentication|unauthorized|forbidden|401|403/i.test(error.message)) return new RemoteApplicationError("denied", error.message, error);
  if (error instanceof Error && /session_not_found|not found/i.test(error.message)) return new RemoteApplicationError("unsupported", error.message, error);
  if (error instanceof TypeError || (error instanceof Error && /fetch|network|connect|socket|econnrefused|timed out/i.test(error.message))) return new RemoteApplicationError("unavailable", error instanceof Error ? error.message : "Remote node is unavailable.", error);
  return new RemoteApplicationError("failed", error instanceof Error ? error.message : "Remote application operation failed.", error);
}
