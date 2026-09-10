import type { PortaApplication } from "./porta-application.js";
import type { Principal } from "./node-delegation.js";
import type { DelegatedTaskRequest, DelegatedTaskAccepted, DelegatedTaskSnapshot, HttpTargetTransport, NodeApplicationDescription, NodeApplicationProtocol, NodeSessionSnapshot, TargetTransportError } from "./target-transport.js";
import { TargetTransportError as TransportError } from "./target-transport.js";

export type RemoteApplicationFailureKind = "unavailable" | "denied" | "unsupported" | "failed";
export class RemoteApplicationError extends Error { constructor(readonly kind: RemoteApplicationFailureKind, message: string, readonly cause?: unknown) { super(message); this.name = "RemoteApplicationError"; } }

export interface RemoteApplicationTransport extends Pick<HttpTargetTransport, "createDelegatedTask" | "getDelegatedTask" | "cancelDelegatedTask" | "describeApplication" | "listApplicationModels" | "createApplicationSession" | "getApplicationSession" | "listApplicationDelegatedTasks"> {}

/** Remote client for application capabilities. It owns transport concerns but no remote state. */
export class RemoteApplicationGateway {
  constructor(private readonly transport: RemoteApplicationTransport) {}
  async describe(): Promise<NodeApplicationDescription> { return this.call(() => this.transport.describeApplication()); }
  async models(): Promise<readonly unknown[]> { return this.call(() => this.transport.listApplicationModels()); }
  async createSession(input: { readonly target?: string; readonly model?: { readonly provider: string; readonly model: string } }): Promise<NodeSessionSnapshot> { return this.call(() => this.transport.createApplicationSession(input)); }
  async getSession(sessionId: string): Promise<NodeSessionSnapshot | undefined> { return this.call(() => this.transport.getApplicationSession(sessionId)); }
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
    async describe() { return { version: 1, nodeIdentity: application.identity.public.identity, capabilities: ["delegatedTasks", "models", "sessions", ...(application.localTarget ? ["primitiveExecution"] : [])] }; },
    async models() { return application.modelCatalog(); },
    async createSession(input, principalIdentity) {
      const events = []; for await (const event of application.gateway.execute({ type: "CreateSession", ...(input.target ? { target: input.target } : {}), ...(input.model ? { model: input.model } : {}) })) events.push(event);
      const created = events.find((event) => event.type === "SessionCreated"); if (!created || created.type !== "SessionCreated") throw new Error("SESSION_CREATE_FAILED");
      sessionOwners.set(created.sessionId, principalIdentity); const session = await application.conversations.getSession(created.sessionId); if (!session) throw new Error("SESSION_CREATE_FAILED"); return sessionSnapshot(session);
    },
    async getSession(sessionId, principalIdentity) { if (sessionOwners.get(sessionId) !== principalIdentity) throw new Error("APPLICATION_ACCESS_DENIED"); const session = await application.conversations.getSession(sessionId); return session ? sessionSnapshot(session) : undefined; },
    async listDelegatedTasks(principalIdentity) { return application.delegatedTasks.list({ kind: "node", identity: principalIdentity }); },
  };
}

function sessionSnapshot(session: { id: string; state: "open" | "closed"; createdAt: string; target?: string; model?: { provider: string; model: string } }): NodeSessionSnapshot { return { id: session.id, state: session.state, createdAt: session.createdAt, ...(session.target ? { target: session.target } : {}), ...(session.model ? { model: session.model } : {}) }; }
function classifyRemoteError(error: unknown): RemoteApplicationError {
  if (error instanceof RemoteApplicationError) return error;
  if (error instanceof TransportError) return new RemoteApplicationError(error.status === 401 || error.status === 403 ? "denied" : error.status === 404 ? "unsupported" : "failed", error.message, error);
  if (error instanceof Error && /authentication|unauthorized|forbidden|401|403/i.test(error.message)) return new RemoteApplicationError("denied", error.message, error);
  if (error instanceof TypeError || (error instanceof Error && /fetch|network|connect|socket|econnrefused|timed out/i.test(error.message))) return new RemoteApplicationError("unavailable", error instanceof Error ? error.message : "Remote node is unavailable.", error);
  return new RemoteApplicationError("failed", error instanceof Error ? error.message : "Remote application operation failed.", error);
}
