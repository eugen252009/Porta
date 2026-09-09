import { createReadStream } from "node:fs";
import { randomBytes, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { stat } from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { ApplicationGateway, HarnessFailure, KernelCommand, KernelEvent, ModelOption, ModelSelection } from "./contracts.js";
import { TaskStore } from "./task.js";
import { attentionFor } from "./attention.js";
import { ProviderRegistry, ProviderConfig } from "./provider-registry.js";
import { buildInfo } from "./build-info.js";
import { LoginService, InstanceIdentityStore } from "./identity.js";
import { WebAuthnService } from "./webauthn.js";
import type { DevelopmentInterventionAction } from "./task.js";
import type { DevelopmentRunner } from "./development-runner.js";

export interface WebApplication {
  gateway: ApplicationGateway;
  modelCatalog?: () => Promise<readonly ModelOption[]>;
  modelCatalogStatus?: () => Promise<{ provider: string; status: "available" | "unavailable"; models: readonly ModelOption[]; error?: string }>;
  modelSelection?: ModelSelection;
  tasks?: Pick<TaskStore, "delete" | "get" | "list">;
  node?: { version: string; name?: string; capabilities: readonly string[] };
  providers?: ProviderRegistry;
  conversations?: import("./contracts.js").ConversationStore;
  pendingApprovals?: Pick<import("./approval-pending.js").PendingApprovalProvider, "pendingRequests">;
  identity?: InstanceIdentityStore;
  login?: LoginService;
  uiSessionToken?: string;
  webauthn?: WebAuthnService;
  uiSessions?: Map<string, number>;
  developmentRunner?: Pick<DevelopmentRunner, "intervene" | "wake" | "release" | "recover">;
}

export interface PortaTarget { id: string; displayName: string; kind: "local" | "remote"; endpoint?: string }
export interface WebServerOptions {
  host?: string;
  port?: number;
  webRoot?: string;
  targets?: readonly PortaTarget[];
  tls?: { mode: "disabled" | "proxy" | "native"; certificatePath?: string; privateKeyPath?: string };
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export function createPortaWebServer(application: WebApplication, options: WebServerOptions = {}) {
  const webRoot = options.webRoot ?? join(process.cwd(), "web");
  const targets = [{ id: "local", displayName: "Local", kind: "local" as const }, ...(options.targets ?? []).filter((target) => target.id !== "local")];
  const uiSessions = application.uiSessions ?? new Map<string, number>();
  const tls = options.tls ?? { mode: "disabled" as const };
  const handler = (request: IncomingMessage, response: ServerResponse) => void route({ ...application, uiSessions }, webRoot, request, response, targets);
  const server = tls.mode === "native" ? createNativeTlsServer(tls, handler) : createServer(handler);
  return {
    server,
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 4173, options.host ?? "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function createNativeTlsServer(tls: NonNullable<WebServerOptions["tls"]>, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  if (!tls.certificatePath || !tls.privateKeyPath) throw new Error("TLS native mode requires an explicit certificate and private key path.");
  const certificate = readFileSync(tls.certificatePath); const privateKey = readFileSync(tls.privateKeyPath);
  const x509 = new X509Certificate(certificate); const key = createPrivateKey(privateKey);
  if (x509.ca) throw new Error("TLS certificate must not be a CA certificate.");
  const now = Date.now(); if (Date.parse(x509.validFrom) > now || Date.parse(x509.validTo) <= now) throw new Error("TLS certificate is not currently valid.");
  const certPublic = x509.publicKey.export({ type: "spki", format: "der" }); const keyPublic = createPublicKey(key).export({ type: "spki", format: "der" });
  if (!certPublic.equals(keyPublic)) throw new Error("TLS certificate and private key do not match.");
  return createSecureServer({ cert: certificate, key: privateKey, allowHTTP1: true }, handler as any);
}

async function route(application: WebApplication, webRoot: string, request: IncomingMessage, response: ServerResponse, targets: readonly PortaTarget[]): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/version") { response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(buildInfo())); return; }
    if (request.method === "GET" && url.pathname === "/ready") { json(response, 200, { ready: true, service: "porta", version: buildInfo() }); return; }
    if (request.method === "POST" && url.pathname === "/auth/webauthn/register/options") { if (!application.webauthn) { json(response, 503, { error: "WEBAUTHN_UNAVAILABLE" }); return; } if (application.webauthn.hasCredentials()) { json(response, 403, { error: "WEBAUTHN_ENROLLMENT_CLOSED" }); return; } json(response, 200, await application.webauthn.registrationOptions()); return; }
    if (request.method === "POST" && url.pathname === "/auth/webauthn/register/verify") { if (!application.webauthn) { json(response, 503, { error: "WEBAUTHN_UNAVAILABLE" }); return; } try { const body = await readJson(request) as any; await application.webauthn.register(String(body.transaction), body.response, typeof body.displayName === "string" ? body.displayName : undefined); const token = randomBytes(32).toString("base64url"); application.uiSessions?.set(token, Date.now() + 8 * 60 * 60 * 1000); response.setHeader("Set-Cookie", `porta_ui=${token}; HttpOnly; SameSite=Strict; Path=/`); json(response, 200, { authenticated: true }); } catch (error) { json(response, 401, { error: error instanceof Error ? error.message : "WEBAUTHN_REGISTRATION_INVALID" }); } return; }
    if (request.method === "POST" && url.pathname === "/auth/webauthn/login/options") { if (!application.webauthn) { json(response, 503, { error: "WEBAUTHN_UNAVAILABLE" }); return; } try { json(response, 200, await application.webauthn.loginOptions()); } catch (error) { json(response, 403, { error: error instanceof Error ? error.message : "WEBAUTHN_NOT_ENROLLED" }); } return; }
    if (request.method === "POST" && url.pathname === "/auth/webauthn/login/verify") { if (!application.webauthn) { json(response, 503, { error: "WEBAUTHN_UNAVAILABLE" }); return; } try { const body = await readJson(request) as any; await application.webauthn.login(String(body.transaction), body.response); const token = randomBytes(32).toString("base64url"); application.uiSessions?.set(token, Date.now() + 8 * 60 * 60 * 1000); response.setHeader("Set-Cookie", `porta_ui=${token}; HttpOnly; SameSite=Strict; Path=/`); json(response, 200, { authenticated: true }); } catch (error) { json(response, 401, { error: error instanceof Error ? error.message : "WEBAUTHN_ASSERTION_INVALID" }); } return; }
    if (request.method === "GET" && url.pathname === "/auth/status") { json(response, 200, { configured: application.webauthn?.hasCredentials() ?? false, authenticated: isUiSessionRequest(application, request) }); return; }
    if (request.method === "POST" && url.pathname === "/auth/logout") { const token = uiCookie(request); if (token) application.uiSessions?.delete(token); response.writeHead(303, { Location: "/login", "Set-Cookie": "porta_ui=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/" }); response.end(); return; }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/setup" || (url.pathname === "/login" && request.headers.accept?.includes("text/html")))) { const authenticated = isUiSessionRequest(application, request); const configured = application.webauthn?.hasCredentials() ?? false; if (authenticated) { response.writeHead(303, { Location: "/app" }); response.end(); return; } if (url.pathname === "/setup" && configured) { response.writeHead(303, { Location: "/login" }); response.end(); return; } if (url.pathname === "/login" && !configured) { response.writeHead(303, { Location: "/setup" }); response.end(); return; } await staticFile(webRoot, "/landing.html", response); return; }
    if (request.method === "GET" && url.pathname === "/app") { if (!isUiSessionRequest(application, request)) { response.writeHead(303, { Location: "/login" }); response.end(); return; } await staticFile(webRoot, "/index.html", response); return; }
    if (request.method === "GET" && url.pathname === "/identity") { if (!application.identity) { json(response, 503, { error: "Identity unavailable." }); return; } json(response, 200, application.identity.public); return; }
    if (request.method === "GET" && url.pathname === "/login") { if (!application.login) { json(response, 503, { error: "Login unavailable." }); return; } json(response, 200, application.login.challenge()); return; }
    if (request.method === "POST" && url.pathname === "/login") { if (!application.login) { json(response, 503, { error: "Login unavailable." }); return; } try { json(response, 200, application.login.login((await readJson(request)) as { challengeId: string; identity: string; signature: string })); } catch (error) { const message = error instanceof Error ? error.message : "LOGIN_FAILED"; json(response, 401, { error: message }); } return; }
    if (url.pathname.startsWith("/api/")) {
      if (!isAuthenticatedApiRequest(application, request)) { json(response, 401, { error: "AUTH_TOKEN_INVALID" }); return; }
      await api(application, url, request, response, targets);
      return;
    }
    await staticFile(webRoot, url.pathname, response);
  } catch (error) {
    if (response.headersSent) response.end();
    else json(response, 500, { error: error instanceof Error ? error.message : "Request failed." });
  }
}

function uiCookie(request: IncomingMessage): string | undefined { return request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("porta_ui="))?.slice("porta_ui=".length); }
function isUiSessionRequest(application: WebApplication, request: IncomingMessage): boolean { const cookie = uiCookie(request); const expiresAt = cookie ? application.uiSessions?.get(cookie) : undefined; if (!expiresAt || expiresAt <= Date.now()) { if (cookie) application.uiSessions?.delete(cookie); return false; } return true; }
function isAuthenticatedApiRequest(application: WebApplication, request: IncomingMessage): boolean { const authorization = request.headers.authorization; if (authorization?.startsWith("Bearer ")) return Boolean(application.login?.authenticateToken(authorization.slice(7).trim())); return isUiSessionRequest(application, request); }

async function api(application: WebApplication, url: URL, request: IncomingMessage, response: ServerResponse, targets: readonly PortaTarget[]): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/identity/allowed") { if (!application.identity) { json(response, 503, { error: "Identity unavailable." }); return; } json(response, 200, { identities: application.identity.listAllowed() }); return; }
  if (request.method === "POST" && url.pathname === "/api/identity/allowed") { if (!application.identity) { json(response, 503, { error: "Identity unavailable." }); return; } const body = await readJson(request) as { identity?: string; publicKey?: string; algorithm?: "ed25519"; displayName?: string }; if (!body.identity || !body.publicKey || body.algorithm !== "ed25519" || !body.displayName) { json(response, 400, { error: "Identity, publicKey, algorithm, and displayName are required." }); return; } application.identity.allow({ identity: body.identity, publicKey: body.publicKey, algorithm: "ed25519" }, body.displayName); json(response, 201, { created: true }); return; }
  if ((request.method === "PATCH" || request.method === "DELETE") && url.pathname.startsWith("/api/identity/allowed/")) { if (!application.identity) { json(response, 503, { error: "Identity unavailable." }); return; } const id = decodeURIComponent(url.pathname.slice("/api/identity/allowed/".length)); if (request.method === "DELETE") application.identity.remove(id); else application.identity.setEnabled(id, Boolean((await readJson(request) as { enabled?: boolean }).enabled)); json(response, 200, { updated: true }); return; }
  const targetId = url.searchParams.get("target") ?? "local";
  if (request.method === "GET" && url.pathname === "/api/targets") { json(response, 200, { targets: targets.map(({ endpoint: _endpoint, ...descriptor }) => descriptor) }); return; }
  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const ids = application.conversations?.openSessionIds() ?? [];
    const tasks = application.tasks ? await application.tasks.list() : [];
    const summaries = await Promise.all(ids.map(async (id) => { const session = await application.conversations?.getSession(id); const task = tasks.find((entry) => entry.sessionId === id); return { sessionId: id, target: session?.target ?? targetId, ...(session?.model ? { model: session.model } : {}), createdAt: session?.createdAt, updatedAt: task?.updatedAt ?? session?.createdAt, state: session?.state, ...(task ? { task: { id: task.id, objective: task.objective.slice(0, 160), status: task.status, ...(task.development ? { phase: task.development.phase, currentAction: task.development.currentAction, attention: task.development.attention ? attentionFor({ status: task.status, reason: task.development.attention.reason }) : attentionFor({ status: task.status }) } : { attention: attentionFor({ status: task.status }) }) } } : {}) }; }));
    json(response, 200, { sessions: summaries.filter((session) => session.state === "open") }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/approvals/pending") { json(response, 200, { approvals: application.pendingApprovals?.pendingRequests() ?? [] }); return; }
  const gateway = application.gateway;
  if (targetId !== "local") { const target = targets.find((candidate) => candidate.id === targetId); if (!target?.endpoint) { json(response, 404, { error: "Target not found." }); return; } await proxyTarget(target.endpoint, request, url, response); return; }
  if (request.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/task")) { const sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/task".length)); const task = application.tasks ? await application.tasks.get(sessionId) : undefined; if (!task) { json(response, 404, { error: "Task was not found." }); return; } json(response, 200, task); return; }
  if ((request.method === "PATCH" || request.method === "DELETE") && url.pathname.startsWith("/api/providers/")) { if (!application.providers) { json(response, 404, { error: "Provider management is unavailable." }); return; } const id = decodeURIComponent(url.pathname.slice("/api/providers/".length)); try { if (request.method === "DELETE") await application.providers.delete(id); else await application.providers.update(id, (await readJson(request) ?? {}) as Partial<Omit<ProviderConfig, "id" | "type">>); json(response, 200, { updated: request.method === "PATCH", deleted: request.method === "DELETE" }); } catch (error) { json(response, 404, { error: error instanceof Error ? error.message : "Provider operation failed." }); } return; }
  if (request.method === "GET" && url.pathname === "/api/providers") { if (!application.providers) { json(response, 200, { providers: [] }); return; } json(response, 200, { providers: await application.providers.describe() }); return; }
  if (request.method === "POST" && url.pathname === "/api/providers/test") { if (!application.providers) { json(response, 404, { error: "Provider management is unavailable." }); return; } const body = await readJson(request); try { const result = await application.providers.test(body as unknown as ProviderConfig); json(response, 200, { ok: true, modelCount: result.models.length, models: result.models }); } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : "Provider test failed." }); } return; }
  if (request.method === "POST" && url.pathname === "/api/providers") { if (!application.providers) { json(response, 404, { error: "Provider management is unavailable." }); return; } try { await application.providers.create((await readJson(request)) as unknown as ProviderConfig); json(response, 201, { created: true }); } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : "Provider could not be created." }); } return; }
  if (request.method === "GET" && url.pathname === "/api/node") { json(response, 200, { node: application.node ?? { version: "unknown" }, capabilities: application.node?.capabilities ?? [] }); return; }
  if (request.method === "GET" && url.pathname === "/api/tasks") { if (!application.tasks) { json(response, 200, { tasks: [] }); return; } const tasks = await application.tasks.list(); json(response, 200, { tasks: tasks.map((task) => ({ id: task.id, sessionId: task.sessionId, version: task.version, objective: task.objective.slice(0, 160), status: task.status, ...(task.failureReason ? { failureReason: task.failureReason } : {}), ...(task.development ? { phase: task.development.phase, currentAction: task.development.currentAction, pendingIntervention: task.development.pendingIntervention, image: task.development.image, deployment: task.development.deployment, executionRecords: task.development.executionRecords, attention: task.development.attention ? attentionFor({ status: task.status, reason: task.development.attention.reason }) : attentionFor({ status: task.status }) } : { attention: attentionFor({ status: task.status }) }), createdAt: task.createdAt, updatedAt: task.updatedAt, deletable: task.status !== "active" && task.status !== "blocked" })) }); return; }
  if (request.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/run")) { const taskId = decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/run".length)); const task = (await application.tasks?.list() ?? []).find((entry) => entry.id === taskId); if (!task?.development) { json(response, 404, { error: "Development task was not found." }); return; } if (!application.developmentRunner) { json(response, 503, { error: "Development runner is unavailable." }); return; } void application.developmentRunner.wake(task.sessionId); json(response, 202, { started: true, taskId }); return; }
  if (request.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/release")) { const taskId = decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/release".length)); const task = (await application.tasks?.list() ?? []).find((entry) => entry.id === taskId); if (!task?.development) { json(response, 404, { error: "Development task was not found." }); return; } try { const updated = await application.developmentRunner?.release(task.sessionId); if (!updated) { json(response, 503, { error: "Development runner is unavailable." }); return; } json(response, 202, updated); } catch (error) { json(response, error instanceof HarnessFailure && error.error.code === "CAPABILITY_UNAVAILABLE" ? 503 : 409, { error: error instanceof HarnessFailure ? error.error : error instanceof Error ? error.message : "Release failed." }); } return; }
  if (request.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/recover")) { const taskId = decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/recover".length)); const task = (await application.tasks?.list() ?? []).find((entry) => entry.id === taskId); if (!task?.development) { json(response, 404, { error: "Development task was not found." }); return; } try { const updated = await application.developmentRunner?.recover(task.sessionId); if (!updated) { json(response, 503, { error: "Development runner is unavailable." }); return; } json(response, 200, updated); } catch (error) { json(response, 409, { error: error instanceof HarnessFailure ? error.error : error instanceof Error ? error.message : "Recovery failed." }); } return; }
  if (request.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/intervention")) { const taskId = decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/intervention".length)); const task = (await application.tasks?.list() ?? []).find((entry) => entry.id === taskId); if (!task || !task.development) { json(response, 404, { error: "Development task was not found." }); return; } if (!application.developmentRunner) { json(response, 503, { error: "Development runner is unavailable." }); return; } const body = await readJson(request) as { version?: number; action?: DevelopmentInterventionAction; input?: string; message?: string }; if (!Number.isInteger(body.version) || !body.action || !["approve", "reject", "provide_input", "resume", "cancel"].includes(body.action)) { json(response, 400, { error: "version and a valid intervention action are required." }); return; } try { const updated = await application.developmentRunner.intervene(task.sessionId, body.version!, body.action, body.input, body.message); if (body.action === "approve" || body.action === "provide_input" || body.action === "resume") void application.developmentRunner.wake(task.sessionId); json(response, 200, updated); } catch (error) { const status = error instanceof HarnessFailure && error.error.code === "CAPABILITY_CONFLICT" ? 409 : 400; json(response, status, { error: error instanceof HarnessFailure ? error.error : error instanceof Error ? error.message : "Intervention failed." }); } return; }
  if (request.method === "GET" && url.pathname.startsWith("/api/tasks/")) { const taskId = decodeURIComponent(url.pathname.slice("/api/tasks/".length)); const task = (await application.tasks?.list() ?? []).find((entry) => entry.id === taskId); if (!task) { json(response, 404, { error: "Task was not found." }); return; } json(response, 200, { ...task, attention: task.development?.attention ? attentionFor({ status: task.status, reason: task.development.attention.reason }) : attentionFor({ status: task.status }) }); return; }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/tasks/")) { const taskId = decodeURIComponent(url.pathname.slice("/api/tasks/".length)); if (!taskId) { json(response, 400, { error: "Task ID is required." }); return; } try { if (!application.tasks) throw new Error("Task deletion is unavailable."); await application.tasks.delete(taskId); json(response, 200, { deleted: true, taskId }); } catch (error) { json(response, error instanceof HarnessFailure && error.error.code === "CAPABILITY_CONFLICT" ? 409 : 404, { error: error instanceof HarnessFailure ? error.error : { code: "TASK_NOT_FOUND", message: error instanceof Error ? error.message : "Task was not found." } }); } return; }
  if (request.method === "GET" && url.pathname === "/api/models") {
    const catalog = application.modelCatalogStatus ? await application.modelCatalogStatus() : { provider: application.modelSelection?.provider, status: "unavailable" as const, models: application.modelCatalog ? await application.modelCatalog() : [], error: "Model catalog is unavailable." };
    json(response, 200, { provider: catalog.provider, status: catalog.status, error: catalog.error, current: application.modelSelection, models: catalog.models });
    return;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "POST" && parts.length === 2 && parts[1] === "sessions") {
    const body = await readJson(request);
    const model = body?.model && typeof body.model === "object" && typeof (body.model as Record<string, unknown>).provider === "string" && typeof (body.model as Record<string, unknown>).model === "string" ? { provider: (body.model as Record<string, string>).provider!, model: (body.model as Record<string, string>).model! } : undefined;
    if (model && application.modelCatalog) { const available = await application.modelCatalog(); if (!available.some((option) => option.provider === model.provider && option.id === model.model)) { json(response, 400, { error: "Selected model is not currently available." }); return; } }
    const events = await collect(gateway.execute({ type: "CreateSession", target: targetId, ...(typeof body?.sessionId === "string" ? { sessionId: body.sessionId } : {}), ...(model ? { model } : {}) }, {}));
    const created = events.find((event): event is Extract<KernelEvent, { type: "SessionCreated" }> => event.type === "SessionCreated");
    if (created) json(response, 200, created);
    else json(response, 400, events.find((event) => event.type === "Error") ?? { error: "Could not create session." });
    return;
  }
  if (parts.length >= 3 && parts[1] === "sessions") {
    const sessionId = decodeURIComponent(parts[2]!);
    if (request.method === "GET" && parts.length === 3) {
      const session = await application.conversations?.getSession(sessionId);
      if (!session) { json(response, 404, { error: "Session was not found." }); return; }
      json(response, 200, { id: session.id, state: session.state, createdAt: session.createdAt, ...(session.target ? { target: session.target } : {}), ...(session.model ? { model: session.model } : {}), history: session.history });
      return;
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "messages") {
      const body = await readJson(request);
      if (typeof body?.input !== "string" || !body.input.trim()) { json(response, 400, { error: "input is required" }); return; }
      response.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "application/x-ndjson; charset=utf-8", "Connection": "keep-alive" });
      // The execution belongs to the session/task, not to the HTTP stream.
      // A browser reconnect must be able to observe the same work instead of
      // cancelling it as a side effect of closing its response body.
      let disconnected = false;
      response.on("close", () => { disconnected = true; });
      for await (const event of gateway.execute({ type: "SubmitInput", sessionId, input: body.input.trim() }, {})) {
        if (!disconnected && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
      }
      // Keep the session open so the browser can submit follow-up messages and
      // resume it after a restart when persistence is enabled. Sessions are
      // closed explicitly through DELETE /api/sessions/:id.
      response.end();
      return;
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "cancel") {
      await collect(gateway.execute({ type: "CancelExecution", sessionId }, {}));
      json(response, 204, null);
      return;
    }
    if (request.method === "DELETE" && parts.length === 3) {
      await collect(gateway.execute({ type: "CloseSession", sessionId }, {}));
      json(response, 204, null);
      return;
    }
  }
  if (request.method === "POST" && parts.length === 3 && parts[1] === "approvals" && parts[2]) {
    const body = await readJson(request);
    if (body?.decision !== "approve" && body?.decision !== "deny") { json(response, 400, { error: "decision must be approve or deny" }); return; }
    const events = await collect(gateway.execute({ type: "ResolveApproval", approvalId: parts[2], decision: body.decision }, {}));
    json(response, events.some((event) => event.type === "Error") ? 400 : 200, events[0] ?? null);
    return;
  }
  json(response, 404, { error: "Not found" });
}

async function staticFile(root: string, pathname: string, response: ServerResponse): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = normalize(join(root, relative));
  if (!target.startsWith(normalize(root))) { json(response, 403, { error: "Forbidden" }); return; }
  try { await stat(target); } catch { json(response, 404, { error: "Not found" }); return; }
  response.writeHead(200, { "Content-Type": contentTypes[extname(target)] ?? "application/octet-stream" });
  createReadStream(target).pipe(response);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 1024 * 1024) throw new Error("Request body is too large.");
  }
  if (!chunks.length) return undefined;
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }
async function proxyTarget(endpoint: string, request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> { const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readRaw(request); const targetUrl = new URL(url.pathname + url.search, endpoint.endsWith("/") ? endpoint : `${endpoint}/`); targetUrl.searchParams.delete("target"); try { const result = await fetch(targetUrl, { method: request.method, headers: { "content-type": request.headers["content-type"] ?? "application/json" }, body: body as unknown as BodyInit }); response.statusCode = result.status; for (const [key, value] of result.headers) if (key !== "content-encoding") response.setHeader(key, value); if (result.body) for await (const chunk of result.body as AsyncIterable<Uint8Array>) response.write(chunk); response.end(); } catch { json(response, 502, { error: "Target is unavailable." }); } }
async function readRaw(request: IncomingMessage): Promise<Uint8Array> { const chunks: Uint8Array[] = []; for await (const chunk of request) chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk); const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0); if (total > 2 * 1024 * 1024) throw new Error("Request body is too large."); const body = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; } return body; }
function json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); if (status !== 204) response.end(JSON.stringify(value)); else response.end(); }
