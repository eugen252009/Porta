import { createReadStream } from "node:fs";
import { randomBytes, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { stat } from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { ApplicationGateway, HarnessFailure, KernelCommand, KernelEvent, ModelOption, ModelSelection, RequestAuthenticator, RequestPrincipal } from "./contracts.js";
import { TaskStore } from "./task.js";
import { attentionFor } from "./attention.js";
import { ProviderRegistry, ProviderConfig } from "./provider-registry.js";
import { optionMatchesSelection, selectionRef } from "./model-identity.js";
import { buildInfo } from "./build-info.js";
import { LoginService, InstanceIdentityStore } from "./identity.js";
import { WebAuthnService } from "./webauthn.js";
import type { DevelopmentInterventionAction } from "./task.js";
import type { DevelopmentRunner } from "./development-runner.js";
import type { TargetRegistry } from "./target.js";
import type { TargetInvocationService } from "./target-invocation.js";
import type { DevelopmentTaskQualificationService } from "./development-task-qualification.js";
import type { DevelopmentTaskCreationService } from "./development-task-creation.js";
import type { TargetPairingService } from "./target-pairing-service.js";
import type { Principal, DelegatedTaskApplicationService } from "./node-delegation.js";
import type { IntegrationCredentialStore } from "./integration-auth.js";
import type { ApplicationEventHub } from "./application-events.js";
import { RemoteApplicationError, type RemoteApplicationGateway } from "./remote-application.js";
import { PromptSubmissionError } from "./prompt-submission.js";
import { handleOpenAIChat, handleOpenAIModels } from "./openai-api.js";
import { CodexWebAuthService } from "./adapters/codex-auth.js";
import type { SessionWorkspaceManager, CreateWorkspaceInput } from "./session-workspaces.js";
import type { GitCredentialStore, GitCredentialInput, GitCredentialType } from "./git-credentials.js";
import { authenticateMaterial, authenticationHeaders, AuthenticationRejected, principalConsensus } from "./request-authentication.js";

export interface WebApplication {
  gateway: ApplicationGateway;
  modelCatalog?: () => Promise<readonly ModelOption[]>;
  modelCatalogStatus?: () => Promise<{ provider: string; status: "available" | "unavailable"; models: readonly ModelOption[]; error?: string }>;
  modelSelection?: ModelSelection;
  resolveModel?: (requested?: string) => Promise<import("./contracts.js").ModelProvider>;
  tasks?: Pick<TaskStore, "delete" | "get" | "list">;
  delegatedTasks?: DelegatedTaskApplicationService;
  promptSubmission?: import("./prompt-submission.js").PromptSubmissionService;
  events?: ApplicationEventHub;
  integrationAuth?: IntegrationCredentialStore;
  node?: { version: string; name?: string; capabilities: readonly string[] };
  executionTargets?: TargetRegistry;
  targetInvocations?: TargetInvocationService;
  developmentQualification?: DevelopmentTaskQualificationService;
  developmentTaskCreation?: DevelopmentTaskCreationService;
  targetPairing?: TargetPairingService;
  providers?: ProviderRegistry;
  conversations?: import("./contracts.js").ConversationStore;
  pendingApprovals?: Pick<import("./approval-pending.js").PendingApprovalProvider, "pendingRequests">;
  identity?: InstanceIdentityStore;
  login?: LoginService;
  uiSessionToken?: string;
  webauthn?: WebAuthnService;
  uiSessions?: Map<string, number>;
  requestAuthenticators?: readonly RequestAuthenticator[];
  inspectSessionCapabilities?: (sessionId: string) => Promise<unknown>;
  developmentRunner?: Pick<DevelopmentRunner, "intervene" | "wake" | "release" | "recover">;
  openAICodexAuth?: CodexWebAuthService;
  workspaces?: SessionWorkspaceManager;
  gitCredentials?: GitCredentialStore;
}

export interface PortaTarget { id: string; displayName: string; kind: "local" | "remote"; endpoint?: string }
interface FederatedNodeCache { sourceNodeId: string; lastSeenAt?: string; stale: boolean; description?: import("./target-transport.js").NodeApplicationDescription }
export interface WebServerOptions {
  host?: string;
  port?: number;
  webRoot?: string;
  targets?: readonly PortaTarget[];
  tls?: { mode: "disabled" | "proxy" | "native"; certificatePath?: string; privateKeyPath?: string };
  extensionOrigins?: readonly string[];
  apiOnly?: boolean;
  /** Required forbids static-bearer-only access; compatible retains the existing API clients. */
  apiAuthentication?: "compatible" | "required";
}

const contentTypes: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export function createPortaWebServer(application: WebApplication, options: WebServerOptions = {}) {
  if (options.apiAuthentication === "required" && !application.requestAuthenticators?.length) throw new Error("Required admission authentication needs a request authenticator.");
  const webRoot = options.webRoot ?? join(process.cwd(), "web");
  const targets = [{ id: "local", displayName: "Local", kind: "local" as const }, ...(options.targets ?? []).filter((target) => target.id !== "local")];
  const uiSessions = application.uiSessions ?? new Map<string, number>();
  const federatedNodeCache = new Map<string, FederatedNodeCache>();
  const tls = options.tls ?? { mode: "disabled" as const };
  const handler = (request: IncomingMessage, response: ServerResponse) => { const origin = request.headers.origin; if (origin && options.extensionOrigins?.includes(origin)) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type"); response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS"); response.setHeader("Vary", "Origin"); } if (request.method === "OPTIONS" && (request.url ?? "").startsWith("/api/")) { response.writeHead(204); response.end(); return; } void route({ ...application, uiSessions }, webRoot, request, response, targets, federatedNodeCache, options.apiOnly ?? false, options.apiAuthentication ?? "compatible"); };
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

async function route(application: WebApplication, webRoot: string, request: IncomingMessage, response: ServerResponse, targets: readonly PortaTarget[], federatedNodeCache: Map<string, FederatedNodeCache>, apiOnly: boolean, apiAuthentication: "compatible" | "required"): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const machineAPI = url.pathname === "/v1" || url.pathname.startsWith("/v1/");
    if (apiOnly && !machineAPI && url.pathname !== "/version" && url.pathname !== "/ready") { json(response, 404, { error: "Not found" }); return; }
    if (!apiOnly && machineAPI) { json(response, 404, { error: "Not found" }); return; }
    if (apiOnly && machineAPI) {
      if (application.requestAuthenticators?.length) authenticateMachineRequest(application, request, apiAuthentication);
      else if (process.env.PORTA_LLM_API_SECRET && request.headers.authorization !== `Bearer ${process.env.PORTA_LLM_API_SECRET}`) { json(response, 401, { error: "unauthorized" }); return; }
    } else if (application.requestAuthenticators?.length && !["/ready", "/version"].includes(url.pathname)) {
      principalForRequest(application, request); // Validate every presented credential before any route or fallback.
    }
    if (request.method === "GET" && url.pathname === "/version") { response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(buildInfo())); return; }
    if (request.method === "GET" && url.pathname === "/ready") { json(response, 200, { ready: true, service: "porta", version: buildInfo() }); return; }
    if (request.method === "GET" && url.pathname === "/v1/models") { if (!application.modelCatalog) { json(response, 503, { error: { message: "Model catalog is unavailable.", type: "server_error", code: "model_catalog_unavailable" } }); return; } await handleOpenAIModels({ modelCatalog: application.modelCatalog }, response); return; }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") { if (!application.modelCatalog || !application.resolveModel) { json(response, 503, { error: { message: "OpenAI-compatible API is unavailable.", type: "server_error", code: "api_unavailable" } }); return; } let body: Record<string, unknown> | undefined; try { body = await readJson(request); } catch { json(response, 400, { error: { message: "Request body must contain valid JSON.", type: "invalid_request_error", code: "invalid_json" } }); return; } if (!body) { json(response, 400, { error: { message: "Request body must be a JSON object.", type: "invalid_request_error", code: "invalid_json" } }); return; } await handleOpenAIChat({ modelCatalog: application.modelCatalog, resolveModel: application.resolveModel }, request, response, body); return; }
    if (request.method === "POST" && url.pathname === "/auth/webauthn/register/options") { if (!application.webauthn) { json(response, 503, { error: "WEBAUTHN_UNAVAILABLE" }); return; } if (application.webauthn.hasCredentials()) { json(response, 403, { error: "WEBAUTHN_ENROLLMENT_CLOSED" }); return; } json(response, 200, await application.webauthn.registrationOptions()); return; }
    if (request.method === "POST" && url.pathname === "/auth/webauthn/register/verify") { if (!application.webauthn) { json(response, 503, { error: "WEBAUTHN_UNAVAILABLE" }); return; } try { const body = await readJson(request) as any; await application.webauthn.register(String(body.transaction), body.response, typeof body.displayName === "string" ? body.displayName : undefined); const token = randomBytes(32).toString("base64url"); application.uiSessions?.set(token, Date.now() + 8 * 60 * 60 * 1000); response.setHeader("Set-Cookie", `porta_ui=${token}; HttpOnly; SameSite=Strict; Path=/`); json(response, 200, { authenticated: true }); } catch (error) { json(response, 401, { error: error instanceof Error ? error.message : "WEBAUTHN_REGISTRATION_INVALID" }); } return; }
    if (request.method === "POST" && url.pathname === "/auth/webauthn/enrollment/options") { if (!application.webauthn) { json(response, 503, { error: "WEBAUTHN_UNAVAILABLE" }); return; } json(response, 200, await application.webauthn.enrollmentOptions()); return; }
    if (request.method === "POST" && url.pathname === "/auth/webauthn/enrollment/verify") { if (!application.webauthn) { json(response, 503, { error: "WEBAUTHN_UNAVAILABLE" }); return; } try { const body = await readJson(request) as any; const credential = await application.webauthn.registerPending(String(body.transaction), body.response, typeof body.displayName === "string" ? body.displayName : "Automation credential"); json(response, 202, { status: "pending", credentialId: credential.credentialId, displayName: credential.displayName, createdAt: credential.createdAt }); } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : "WEBAUTHN_ENROLLMENT_INVALID" }); } return; }
    if (request.method === "POST" && url.pathname === "/auth/webauthn/login/options") { if (!application.webauthn) { json(response, 503, { error: "WEBAUTHN_UNAVAILABLE" }); return; } try { json(response, 200, await application.webauthn.loginOptions()); } catch (error) { json(response, 403, { error: error instanceof Error ? error.message : "WEBAUTHN_NOT_ENROLLED" }); } return; }
    if (request.method === "POST" && url.pathname === "/auth/webauthn/login/verify") { if (!application.webauthn) { json(response, 503, { error: "WEBAUTHN_UNAVAILABLE" }); return; } try { const body = await readJson(request) as any; await application.webauthn.login(String(body.transaction), body.response); const token = randomBytes(32).toString("base64url"); application.uiSessions?.set(token, Date.now() + 8 * 60 * 60 * 1000); response.setHeader("Set-Cookie", `porta_ui=${token}; HttpOnly; SameSite=Strict; Path=/`); json(response, 200, { authenticated: true }); } catch (error) { json(response, 401, { error: error instanceof Error ? error.message : "WEBAUTHN_ASSERTION_INVALID" }); } return; }
    if (request.method === "GET" && url.pathname === "/auth/status") { json(response, 200, { configured: application.webauthn?.hasCredentials() ?? false, authenticated: Boolean(humanPrincipalForRequest(application, request)) }); return; }
    if (request.method === "POST" && url.pathname === "/auth/logout") { const token = uiCookie(request); if (token) application.uiSessions?.delete(token); response.writeHead(303, { Location: "/login", "Set-Cookie": "porta_ui=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/" }); response.end(); return; }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/setup" || (url.pathname === "/login" && request.headers.accept?.includes("text/html")))) { const authenticated = Boolean(humanPrincipalForRequest(application, request)); const configured = application.webauthn?.hasCredentials() ?? false; if (authenticated) { response.writeHead(303, { Location: "/app" }); response.end(); return; } if (url.pathname === "/setup" && configured) { response.writeHead(303, { Location: "/login" }); response.end(); return; } if (url.pathname === "/login" && !configured) { response.writeHead(303, { Location: "/setup" }); response.end(); return; } await staticFile(webRoot, "/landing.html", response); return; }
    if (request.method === "GET" && url.pathname === "/app") { if (!humanPrincipalForRequest(application, request)) { response.writeHead(303, { Location: "/login" }); response.end(); return; } await staticFile(webRoot, "/index.html", response); return; }
    if (request.method === "GET" && url.pathname === "/identity") { if (!application.identity) { json(response, 503, { error: "Identity unavailable." }); return; } json(response, 200, application.identity.public); return; }
    if (request.method === "GET" && url.pathname === "/login") { if (!application.login) { json(response, 503, { error: "Login unavailable." }); return; } json(response, 200, application.login.challenge()); return; }
    if (request.method === "POST" && url.pathname === "/login") { if (!application.login) { json(response, 503, { error: "Login unavailable." }); return; } try { json(response, 200, application.login.login((await readJson(request)) as { challengeId: string; identity: string; signature: string })); } catch (error) { const message = error instanceof Error ? error.message : "LOGIN_FAILED"; json(response, 401, { error: message }); } return; }
    if (url.pathname === "/api/events" && request.method === "GET") { if (!principalForRequest(application, request)) { json(response, 401, { error: "AUTH_TOKEN_INVALID" }); return; } response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" }); response.write(": connected\n\n"); const unsubscribe = application.events?.subscribe((event) => { if (!response.writableEnded) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }); request.on("close", () => unsubscribe?.()); return; }
    if (url.pathname.startsWith("/api/")) {
      if (!isAuthenticatedApiRequest(application, request)) { json(response, 401, { error: "AUTH_TOKEN_INVALID" }); return; }
      await api(application, url, request, response, targets, federatedNodeCache);
      return;
    }
    await staticFile(webRoot, url.pathname, response);
  } catch (error) {
    if (response.headersSent) response.end();
    else if (error instanceof AuthenticationRejected) { json(response, 401, { error: "AUTHENTICATION_REJECTED" }); }
    else { const status = error instanceof RemoteApplicationError ? (error.kind === "denied" ? 403 : error.kind === "unsupported" ? 404 : error.kind === "unavailable" ? 503 : 502) : 500; json(response, status, { error: error instanceof Error ? error.message : "Request failed.", kind: error instanceof RemoteApplicationError ? error.kind : "failed" }); }
  }
}

function sessionStatus(history: readonly { readonly role?: string }[]): "ready" | "working" | "completed" { const last = history[history.length - 1]; return last?.role === "assistant" ? "completed" : last?.role === "user" ? "working" : "ready" }
function uiCookie(request: IncomingMessage): string | undefined { return request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("porta_ui="))?.slice("porta_ui=".length); }
function isUiSessionRequest(application: WebApplication, request: IncomingMessage): boolean { const cookie = uiCookie(request); const expiresAt = cookie ? application.uiSessions?.get(cookie) : undefined; if (!expiresAt || expiresAt <= Date.now()) { if (cookie) application.uiSessions?.delete(cookie); return false; } return true; }
function humanPrincipalForRequest(application: WebApplication, request: IncomingMessage): Principal | undefined { const principal = principalForRequest(application, request); return principal?.kind === "human" ? principal : undefined; }
function legacyPrincipalForRequest(application: WebApplication, request: IncomingMessage): Principal | undefined { const authorization = request.headers.authorization; if (authorization?.startsWith("Bearer ")) { const token = authorization.slice(7).trim(); const integration = application.integrationAuth?.authenticate(token); if (integration) return integration; const identity = application.login?.authenticateToken(token); return identity ? { kind: "node", identity } : undefined; } const cookie = uiCookie(request); return isUiSessionRequest(application, request) ? { kind: "human", identity: `web:${cookie ?? "authenticated"}` } : undefined; }
const requestPrincipals = new WeakMap<IncomingMessage, Principal | undefined>();
function principalForRequest(application: WebApplication, request: IncomingMessage): Principal | undefined {
  if (!application.requestAuthenticators?.length) return legacyPrincipalForRequest(application, request);
  if (requestPrincipals.has(request)) return requestPrincipals.get(request);
  const material = authenticationHeaders(request);
  const providers: RequestAuthenticator[] = [...application.requestAuthenticators, { authenticate({ authorization }) {
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const token = authorization.slice(7).trim();
    const integration = application.integrationAuth?.authenticate(token);
    const identity = application.login?.authenticateToken(token);
    return principalConsensus([...(integration ? [integration] : []), ...(identity ? [{ kind: "node" as const, identity }] : [])]);
  } }];
  const principals: RequestPrincipal[] = [];
  for (const credential of [material.authorization !== undefined ? { authorization: material.authorization } : undefined, material.admission !== undefined ? { admission: material.admission } : undefined]) {
    if (!credential) continue;
    const principal = authenticateMaterial(providers, credential);
    if (!principal) throw new AuthenticationRejected();
    principals.push(principal);
  }
  const cookie = uiCookie(request);
  if (cookie !== undefined) {
    if (!isUiSessionRequest(application, request)) throw new AuthenticationRejected();
    principals.push({ kind: "human", identity: `web:${cookie}` });
  }
  const principal = principalConsensus(principals);
  const result = principal ? toPrincipal(principal) : undefined;
  requestPrincipals.set(request, result);
  return result;
}

function authenticateMachineRequest(application: WebApplication, request: IncomingMessage, mode: "compatible" | "required"): void {
  const material = authenticationHeaders(request);
  // Browser sessions never authorize the machine listener.
  if (uiCookie(request) !== undefined) throw new AuthenticationRejected();
  const principals: RequestPrincipal[] = [];
  const secret = process.env.PORTA_LLM_API_SECRET;
  const legacy = Boolean(secret) && material.authorization === `Bearer ${secret}`;
  if (material.authorization !== undefined && !legacy) {
    const principal = authenticateMaterial(application.requestAuthenticators!, { authorization: material.authorization });
    if (!principal) throw new AuthenticationRejected();
    principals.push(principal);
  }
  if (material.admission !== undefined) {
    const principal = authenticateMaterial(application.requestAuthenticators!, { admission: material.admission });
    if (!principal) throw new AuthenticationRejected();
    principals.push(principal);
  }
  const principal = principalConsensus(principals);
  if (!principal && !(mode === "compatible" && legacy && material.admission === undefined)) throw new AuthenticationRejected();
  if (principal) requestPrincipals.set(request, toPrincipal(principal));
}
function toPrincipal(principal: RequestPrincipal): Principal { if (principal.kind === "integration") return { kind: "integration", identity: principal.identity, permissions: principal.permissions }; return { kind: principal.kind, identity: principal.identity }; }
function isAuthenticatedApiRequest(application: WebApplication, request: IncomingMessage): boolean { return Boolean(principalForRequest(application, request)); }

async function api(application: WebApplication, url: URL, request: IncomingMessage, response: ServerResponse, targets: readonly PortaTarget[], federatedNodeCache: Map<string, FederatedNodeCache>): Promise<void> {
  const principal = principalForRequest(application, request); if (!principal) { json(response, 401, { error: "AUTH_TOKEN_INVALID" }); return; }
  if (url.pathname === "/api/providers/openai/status" || url.pathname === "/api/providers/openai/login" || url.pathname.startsWith("/api/providers/openai/login/") || url.pathname === "/api/providers/openai/disconnect") {
    if (principal.kind !== "human" || !application.openAICodexAuth) { json(response, 403, { error: "OPENAI_AUTH_PERMISSION_DENIED" }); return; }
    if (request.method === "GET" && url.pathname === "/api/providers/openai/status") { json(response, 200, await application.openAICodexAuth.status()); return; }
    if (request.method === "POST" && url.pathname === "/api/providers/openai/login") { const body = await readJson(request); const method = body?.method === "browser" ? "browser" : "device_code"; json(response, 202, application.openAICodexAuth.startLogin(method)); return; }
    if (request.method === "GET" && url.pathname.startsWith("/api/providers/openai/login/")) { const id = decodeURIComponent(url.pathname.slice("/api/providers/openai/login/".length)); json(response, 200, await application.openAICodexAuth.loginStatus(id)); return; }
    if (request.method === "POST" && url.pathname === "/api/providers/openai/disconnect") { await application.openAICodexAuth.disconnect(); json(response, 200, { status: "disconnected" }); return; }
    json(response, 405, { error: "METHOD_NOT_ALLOWED" }); return;
  }
  if (url.pathname === "/api/auth/webauthn/credentials" || url.pathname === "/api/auth/webauthn/pending") {
    if (principal.kind !== "human" || !application.webauthn) { json(response, 403, { error: "WEBAUTHN_PERMISSION_DENIED" }); return; }
    const publicCredential = ({ credentialId, displayName, createdAt, lastUsedAt, transports }: import("./webauthn.js").WebAuthnCredential) => ({ credentialId, displayName, createdAt, ...(lastUsedAt ? { lastUsedAt } : {}), ...(transports ? { transports } : {}) });
    if (url.pathname === "/api/auth/webauthn/credentials" && request.method === "GET") { json(response, 200, { credentials: application.webauthn.list().map(publicCredential) }); return; }
    if (url.pathname === "/api/auth/webauthn/credentials" && request.method === "DELETE") { const id = decodeURIComponent(url.pathname.slice("/api/auth/webauthn/credentials/".length)); try { application.webauthn.remove(id); json(response, 200, { revoked: true, credentialId: id }); } catch (error) { json(response, 409, { error: error instanceof Error ? error.message : "WEBAUTHN_CREDENTIAL_REVOKE_FAILED" }); } return; }
    if (url.pathname === "/api/auth/webauthn/pending" && request.method === "GET") { json(response, 200, { credentials: application.webauthn.listPending().map(publicCredential) }); return; }
    if (url.pathname === "/api/auth/webauthn/pending" && request.method === "POST") { const body = await readJson(request) as { credentialId?: string; action?: string }; if (typeof body.credentialId !== "string" || (body.action !== "approve" && body.action !== "reject")) { json(response, 400, { error: "credentialId and action are required" }); return; } try { if (body.action === "approve") application.webauthn.approvePending(body.credentialId); else application.webauthn.rejectPending(body.credentialId); json(response, 200, { status: body.action === "approve" ? "active" : "rejected", credentialId: body.credentialId }); } catch (error) { json(response, 404, { error: error instanceof Error ? error.message : "WEBAUTHN_PENDING_CREDENTIAL_UNKNOWN" }); } return; }
    json(response, 405, { error: "METHOD_NOT_ALLOWED" }); return;
  }
  if (url.pathname.startsWith("/api/auth/webauthn/credentials/") && request.method === "DELETE") {
    if (principal.kind !== "human" || !application.webauthn) { json(response, 403, { error: "WEBAUTHN_PERMISSION_DENIED" }); return; }
    const id = decodeURIComponent(url.pathname.slice("/api/auth/webauthn/credentials/".length)); try { application.webauthn.remove(id); json(response, 200, { revoked: true, credentialId: id }); } catch (error) { json(response, 409, { error: error instanceof Error ? error.message : "WEBAUTHN_CREDENTIAL_REVOKE_FAILED" }); } return;
  }
  if (request.method === "GET" && url.pathname === "/api/integrations") { if (principal.kind !== "human" || !application.integrationAuth) { json(response, 403, { error: "INTEGRATION_PERMISSION_DENIED" }); return; } json(response, 200, { integrations: application.integrationAuth.list() }); return; }
  if (request.method === "POST" && url.pathname === "/api/integrations") { if (principal.kind !== "human" || !application.integrationAuth) { json(response, 403, { error: "INTEGRATION_PERMISSION_DENIED" }); return; } const body = await readJson(request); const permissions = Array.isArray(body?.permissions) && body.permissions.every((permission) => typeof permission === "string") ? body.permissions as string[] : []; if (typeof body?.label !== "string" || !permissions.length || permissions.some((permission) => !["nodes.read", "models.read", "prompt.submit"].includes(permission))) { json(response, 400, { error: "Invalid integration credential." }); return; } json(response, 201, application.integrationAuth.create(body.label, permissions)); return; }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/integrations/")) { if (principal.kind !== "human" || !application.integrationAuth) { json(response, 403, { error: "INTEGRATION_PERMISSION_DENIED" }); return; } application.integrationAuth.revoke(decodeURIComponent(url.pathname.slice("/api/integrations/".length))); json(response, 200, { revoked: true }); return; }
  if (request.method === "POST" && url.pathname === "/api/prompt/submit") { const body = await readJson(request); const model = body?.requestedModel && typeof body.requestedModel === "object" ? body.requestedModel as { provider: string; model: string } : undefined; if (!application.promptSubmission || typeof body?.content !== "string" || typeof body?.idempotencyKey !== "string") { json(response, 400, { error: "content and idempotencyKey are required." }); return; } if (principal.kind !== "human" && !(principal.kind === "integration" && application.integrationAuth?.allows(principal, "prompt.submit"))) { json(response, 403, { error: "PROMPT_SUBMIT_NOT_AUTHORIZED" }); return; } try { json(response, 202, await application.promptSubmission.submit({ content: body.content, idempotencyKey: body.idempotencyKey, ...(typeof body.targetNodeId === "string" ? { targetNodeId: body.targetNodeId } : {}), ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}), ...(model ? { requestedModel: model } : {}), ...(body.mode === "agent" || body.mode === "chat" ? { mode: body.mode } : {}), ...(typeof body.source === "string" ? { source: body.source.slice(0, 80) } : {}) }, principal)); } catch (error) { const status = error instanceof PromptSubmissionError ? (error.kind === "denied" ? 403 : error.kind === "unsupported" || error.kind === "not_found" ? 404 : error.kind === "unavailable" ? 503 : 409) : 400; json(response, status, { error: error instanceof Error ? error.message : "Prompt submission failed.", kind: error instanceof PromptSubmissionError ? error.kind : "failed" }); } return; }
  if (principal.kind === "integration") { const required = url.pathname === "/api/nodes" ? "nodes.read" : url.pathname === "/api/models" ? "models.read" : url.pathname === "/api/prompt/submit" ? "prompt.submit" : undefined; if (!required || !application.integrationAuth?.allows(principal, required)) { json(response, 403, { error: "INTEGRATION_PERMISSION_DENIED" }); return; } }
  if (request.method === "GET" && url.pathname === "/api/identity/allowed") { if (!application.identity) { json(response, 503, { error: "Identity unavailable." }); return; } json(response, 200, { identities: application.identity.listAllowed() }); return; }
  if (request.method === "POST" && url.pathname === "/api/identity/allowed") { if (!application.identity) { json(response, 503, { error: "Identity unavailable." }); return; } const body = await readJson(request) as { identity?: string; publicKey?: string; algorithm?: "ed25519"; displayName?: string }; if (!body.identity || !body.publicKey || body.algorithm !== "ed25519" || !body.displayName) { json(response, 400, { error: "Identity, publicKey, algorithm, and displayName are required." }); return; } application.identity.allow({ identity: body.identity, publicKey: body.publicKey, algorithm: "ed25519" }, body.displayName); json(response, 201, { created: true }); return; }
  if ((request.method === "PATCH" || request.method === "DELETE") && url.pathname.startsWith("/api/identity/allowed/")) { if (!application.identity) { json(response, 503, { error: "Identity unavailable." }); return; } const id = decodeURIComponent(url.pathname.slice("/api/identity/allowed/".length)); if (request.method === "DELETE") application.identity.remove(id); else application.identity.setEnabled(id, Boolean((await readJson(request) as { enabled?: boolean }).enabled)); json(response, 200, { updated: true }); return; }
  if (request.method === "POST" && url.pathname === "/api/execution-targets/pair") { try { if (!application.targetPairing) { json(response, 503, { error: "Target pairing is unavailable." }); return; } const payload = await readJson(request) as unknown as import("./target-pairing.js").PairingPayload; json(response, 201, await application.targetPairing.pair(payload)); } catch (error) { json(response, 409, { error: error instanceof Error ? error.message : "Target pairing failed." }); } return; }
  if (request.method === "POST" && url.pathname.startsWith("/api/development-tasks/") && url.pathname.endsWith("/cancel")) { try { const taskId = decodeURIComponent(url.pathname.slice("/api/development-tasks/".length, -"/cancel".length)); if (!application.developmentTaskCreation) { json(response, 503, { error: "Development task creation is unavailable." }); return; } json(response, 200, await application.developmentTaskCreation.cancel(taskId)); } catch (error) { json(response, 409, { error: error instanceof Error ? error.message : "Development task could not be cancelled." }); } return; }
  if (request.method === "POST" && url.pathname === "/api/development-tasks") { try {
    if (!application.developmentTaskCreation) { json(response, 503, { error: "Development task creation is unavailable." }); return; }
    const body = await readJson(request) as Record<string, unknown>;
    const permissions = body.permissions as Record<string, unknown> | undefined;
    const workspace = body.workspace as Record<string, unknown> | undefined;
    const strings = (value: unknown): readonly string[] | undefined => Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
    if (typeof body.goal !== "string" || typeof body.developmentTargetId !== "string" || typeof workspace?.id !== "string" || typeof workspace.path !== "string" || !permissions || typeof permissions.mutate !== "boolean" || typeof permissions.commit !== "boolean" || typeof permissions.push !== "boolean" || typeof permissions.deploy !== "boolean") { json(response, 400, { error: "goal, workspace, target, and boolean permissions are required." }); return; }
    const acceptanceCriteria = strings(body.acceptanceCriteria); if (!acceptanceCriteria) { json(response, 400, { error: "acceptanceCriteria must be an array of strings." }); return; }
    const task = await application.developmentTaskCreation.create({ goal: body.goal, targetId: body.developmentTargetId, workspaceId: workspace.id, workspacePath: workspace.path, acceptanceCriteria, permissions: { mutate: permissions.mutate, commit: permissions.commit, push: permissions.push, deploy: permissions.deploy }, ...(strings(body.constraints) ? { constraints: strings(body.constraints) } : {}), ...(strings(body.focusedCommands) ? { focusedCommands: strings(body.focusedCommands) } : {}), ...(strings(body.fullCommands) ? { fullCommands: strings(body.fullCommands) } : {}) }); json(response, 201, task);
  } catch (error) { json(response, 409, { error: error instanceof Error ? error.message : "Development task could not be created." }); } return; }
  if (request.method === "POST" && url.pathname === "/api/development-qualification") { try { const task = await application.developmentQualification?.create("pc-main"); if (!task) { json(response, 503, { error: "Development qualification is unavailable." }); return; } json(response, 201, task); } catch (error) { json(response, 409, { error: error instanceof Error ? error.message : "Qualification task could not be created." }); } return; }
  if (request.method === "POST" && url.pathname.startsWith("/api/development-qualification/") && url.pathname.endsWith("/run")) { const sessionId = decodeURIComponent(url.pathname.slice("/api/development-qualification/".length, -"/run".length)); try { const task = await application.developmentQualification?.run(sessionId); if (!task) { json(response, 404, { error: "Qualification task was not found." }); return; } json(response, 202, task); } catch (error) { json(response, 409, { error: error instanceof Error ? error.message : "Qualification task could not run." }); } return; }
  if (request.method === "POST" && url.pathname === "/api/execution-invocations") { const body = await readJson(request); if (typeof body?.targetId !== "string" || typeof body.workspaceId !== "string" || typeof body.operation !== "string") { json(response, 400, { error: "targetId, workspaceId, and operation are required." }); return; } try { const evidence = application.targetInvocations?.start({ targetId: body.targetId, workspaceId: body.workspaceId, operation: body.operation as import("./target-transport.js").TargetOperation, input: body.input, ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}), ...(typeof body.deadline === "number" ? { deadline: body.deadline } : {}) }); if (!evidence) { json(response, 503, { error: "Target invocation is unavailable." }); return; } json(response, 202, evidence); } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : "Target invocation failed." }); } return; }
  if (request.method === "GET" && url.pathname.startsWith("/api/execution-invocations/")) { const id = decodeURIComponent(url.pathname.slice("/api/execution-invocations/".length)); const evidence = application.targetInvocations?.get(id); if (!evidence) { json(response, 404, { error: "Invocation was not found." }); return; } json(response, 200, evidence); return; }
  if (request.method === "POST" && url.pathname.startsWith("/api/execution-invocations/") && url.pathname.endsWith("/cancel")) { const id = decodeURIComponent(url.pathname.slice("/api/execution-invocations/".length, -"/cancel".length)); if (!application.targetInvocations?.cancel(id)) { json(response, 404, { error: "Invocation was not found." }); return; } json(response, 202, { cancelled: true, invocationId: id }); return; }
  const targetId = url.searchParams.get("target") ?? "local";
  if (request.method === "GET" && url.pathname === "/api/nodes") { json(response, 200, { nodes: await federatedNodes(application, targets, federatedNodeCache) }); return; }
  const remote = targetId === "local" ? undefined : remoteApplicationFor(application, targetId);
  if (targetId !== "local" && !remote && ["/api/models", "/api/sessions", "/api/tasks", "/api/approvals", "/api/delegated-tasks"].some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) { json(response, 404, { error: "NODE_NOT_KNOWN" }); return; }
  if (remote && request.method === "GET" && url.pathname === "/api/models") { json(response, 200, { models: await remote.models() }); return; }
  if (remote && request.method === "GET" && url.pathname === "/api/sessions") { json(response, 200, { sessions: await remote.listSessions() }); return; }
  if (remote && request.method === "GET" && url.pathname === "/api/tasks") { json(response, 200, { tasks: await remote.listTasks() }); return; }
  if (remote && request.method === "GET" && url.pathname === "/api/approvals/pending") { json(response, 200, { approvals: await remote.listApprovals() }); return; }
  if (remote && request.method === "POST" && url.pathname.startsWith("/api/approvals/") && !url.pathname.endsWith("/pending")) { const approvalId = decodeURIComponent(url.pathname.slice("/api/approvals/".length)); const body = await readJson(request); if (body?.decision !== "approve" && body?.decision !== "deny") { json(response, 400, { error: "decision must be approve or deny" }); return; } json(response, 200, await remote.resolveApproval(approvalId, body.decision, typeof body.reason === "string" ? body.reason : undefined)); return; }
  if (remote && request.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/task")) { const sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/task".length)); const task = await remote.getTask(sessionId); if (!task) { json(response, 404, { error: "Task was not found." }); return; } json(response, 200, task); return; }
  if (remote && request.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/run")) { const task = await remote.runTask(decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/run".length))); if (!task) { json(response, 404, { error: "Task was not found." }); return; } json(response, 200, task); return; }
  if (remote && request.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/release")) { const task = await remote.releaseTask(decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/release".length))); if (!task) { json(response, 404, { error: "Task was not found." }); return; } json(response, 200, task); return; }
  if (remote && request.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/recover")) { const task = await remote.recoverTask(decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/recover".length))); if (!task) { json(response, 404, { error: "Task was not found." }); return; } json(response, 200, task); return; }
  if (remote && request.method === "POST" && url.pathname.startsWith("/api/tasks/") && url.pathname.endsWith("/intervention")) { const taskId = decodeURIComponent(url.pathname.slice("/api/tasks/".length, -"/intervention".length)); const body = await readJson(request); if (!Number.isInteger(body?.version) || typeof body?.action !== "string") { json(response, 400, { error: "version and action are required" }); return; } const task = await remote.interveneTask(taskId, body.version as number, body.action as import("./task.js").DevelopmentInterventionAction, typeof body.input === "string" ? body.input : undefined, typeof body.message === "string" ? body.message : undefined); if (!task) { json(response, 404, { error: "Task was not found." }); return; } json(response, 200, task); return; }
  if (remote && request.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/cancel")) { const sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/cancel".length)); json(response, 200, await remote.cancelSession(sessionId)); return; }
  if (remote && request.method === "POST" && url.pathname === "/api/sessions") { const body = await readJson(request); if (body?.repository || body?.savedProjectId || body?.gitCredential || body?.credentialIds) { json(response, 400, { error: "Project workspaces are only available on the local Porta node." }); return; } const model = body?.model && typeof body.model === "object" ? body.model as { provider: string; model: string } : undefined; try { json(response, 200, { type: "SessionCreated", sessionId: (await remote.createSession({ ...(model ? { model } : {}) })).id }); } catch (error) { json(response, 409, { error: error instanceof Error ? error.message : "Remote session creation failed." }); } return; }
  if (remote && request.method === "GET" && url.pathname.startsWith("/api/sessions/") && !url.pathname.endsWith("/task")) { const sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length)); const session = await remote.getSession(sessionId); if (!session) { json(response, 404, { error: "Session was not found." }); return; } json(response, 200, session); return; }
  if (remote && request.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/messages")) { const sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/messages".length)); const body = await readJson(request); if (typeof body?.input !== "string" || !body.input.trim()) { json(response, 400, { error: "input is required" }); return; } json(response, 200, await remote.submitSession(sessionId, body.input)); return; }
  if (remote && request.method === "GET" && url.pathname === "/api/delegated-tasks") { json(response, 200, { tasks: await remote.listDelegatedTasks() }); return; }
  if (remote && url.pathname.startsWith("/api/sessions/") && !(request.method === "GET" && !url.pathname.endsWith("/task")) && !(request.method === "POST" && (url.pathname.endsWith("/messages") || url.pathname.endsWith("/cancel")))) { json(response, 501, { error: "REMOTE_SESSION_OPERATION_UNSUPPORTED", kind: "unsupported" }); return; }
  const sessionGitCredentialRoute = /^\/api\/sessions\/([^/]+)\/git-credentials$/.exec(url.pathname);
  if (sessionGitCredentialRoute && (request.method === "GET" || request.method === "PUT")) {
    if (targetId !== "local" || principal.kind !== "human" || !application.workspaces || !application.gitCredentials) { json(response, 403, { error: "GIT_CREDENTIAL_PERMISSION_DENIED" }); return; }
    const sessionId = decodeURIComponent(sessionGitCredentialRoute[1]!); const session = await application.conversations?.getSession(sessionId);
    if (!session || session.state !== "open") { json(response, 404, { error: "An open local session was not found." }); return; }
    if (request.method === "GET") { json(response, 200, { credentialIds: await application.workspaces.credentialIdsForSession(sessionId), credentials: await application.gitCredentials.listForSession(sessionId) }); return; }
    try { const body = await readJson(request); if (!body || Object.keys(body).some((key) => key !== "credentialIds" && key !== "expectedCredentialIds") || !Array.isArray(body.credentialIds) || body.credentialIds.some((id) => typeof id !== "string") || !Array.isArray(body.expectedCredentialIds) || body.expectedCredentialIds.some((id) => typeof id !== "string")) { json(response, 400, { error: "credentialIds and expectedCredentialIds must be arrays of credential IDs." }); return; } const workspace = await application.workspaces.updateCredentialAssignments(sessionId, body.credentialIds as string[], body.expectedCredentialIds as string[]); json(response, 200, { workspace, credentialIds: await application.workspaces.credentialIdsForSession(sessionId) }); }
    catch (error) { respondWorkspaceError(response, error); }
    return;
  }
  if (url.pathname === "/api/projects" && request.method === "GET") { if (targetId !== "local" || principal.kind !== "human" || !application.workspaces) { json(response, 403, { error: "PROJECT_PERMISSION_DENIED" }); return; } json(response, 200, { projects: await application.workspaces.savedProjects() }); return; }
  if (url.pathname.startsWith("/api/projects/") && request.method === "DELETE") { if (targetId !== "local" || principal.kind !== "human" || !application.workspaces) { json(response, 403, { error: "PROJECT_PERMISSION_DENIED" }); return; } try { await application.workspaces.deleteSavedProject(decodeURIComponent(url.pathname.slice("/api/projects/".length))); json(response, 200, { deleted: true }); } catch (error) { respondWorkspaceError(response, error); } return; }
  if (url.pathname === "/api/git-credentials/github" && request.method === "GET") { if (targetId !== "local" || principal.kind !== "human" || !application.gitCredentials) { json(response, 403, { error: "GIT_CREDENTIAL_PERMISSION_DENIED" }); return; } const credential = await application.gitCredentials.githubSshKey(); json(response, 200, { configured: Boolean(credential), credential: credential ?? null }); return; }
  if (url.pathname === "/api/git-credentials/github" && request.method === "POST") { if (targetId !== "local" || principal.kind !== "human" || !application.gitCredentials) { json(response, 403, { error: "GIT_CREDENTIAL_PERMISSION_DENIED" }); return; } try { const body = await readJson(request); if (body && Object.keys(body).length) throw new HarnessFailure({ code: "VALIDATION_FAILED", message: "GitHub key creation accepts no client-supplied key material.", retryable: false }); const result = await application.gitCredentials.createGithubSshKey(); json(response, result.created ? 201 : 200, result); } catch (error) { respondWorkspaceError(response, error); } return; }
  if (url.pathname === "/api/git-credentials/github/rotate" && request.method === "POST") { if (targetId !== "local" || principal.kind !== "human" || !application.gitCredentials) { json(response, 403, { error: "GIT_CREDENTIAL_PERMISSION_DENIED" }); return; } try { const body = await readJson(request); if (body && Object.keys(body).length) throw new HarnessFailure({ code: "VALIDATION_FAILED", message: "GitHub key rotation accepts no client-supplied key material.", retryable: false }); json(response, 201, await application.gitCredentials.createGithubSshKey(true)); } catch (error) { respondWorkspaceError(response, error); } return; }
  if (url.pathname === "/api/git-credentials/github/verify" && request.method === "POST") { if (targetId !== "local" || principal.kind !== "human" || !application.gitCredentials) { json(response, 403, { error: "GIT_CREDENTIAL_PERMISSION_DENIED" }); return; } const controller = new AbortController(); const abort = () => controller.abort(); request.once("aborted", abort); response.once("close", () => { if (!response.writableEnded) controller.abort(); }); try { const body = await readJson(request); if (body && Object.keys(body).length) { json(response, 400, { error: "GitHub SSH verification accepts no key material." }); return; } json(response, 200, await application.gitCredentials.verifyGithubSshKey(controller.signal)); } catch { json(response, 500, { error: "GitHub SSH verification could not complete." }); } finally { request.off("aborted", abort); } return; }
  if (url.pathname === "/api/git-credentials" && request.method === "GET") { if (targetId !== "local" || principal.kind !== "human" || !application.gitCredentials) { json(response, 403, { error: "GIT_CREDENTIAL_PERMISSION_DENIED" }); return; } const sessionId = url.searchParams.get("sessionId") ?? ""; json(response, 200, { credentials: await application.gitCredentials.listForSession(sessionId) }); return; }
  if (url.pathname === "/api/git-credentials" && request.method === "POST") { if (targetId !== "local" || principal.kind !== "human" || !application.gitCredentials) { json(response, 403, { error: "GIT_CREDENTIAL_PERMISSION_DENIED" }); return; } try { const credential = parseGitCredential(await readJson(request), "global"); json(response, 201, { credential: await application.gitCredentials.create(credential) }); } catch (error) { respondWorkspaceError(response, error); } return; }
  if (url.pathname.startsWith("/api/git-credentials/") && request.method === "DELETE") { if (targetId !== "local" || principal.kind !== "human" || !application.gitCredentials) { json(response, 403, { error: "GIT_CREDENTIAL_PERMISSION_DENIED" }); return; } try { const id = decodeURIComponent(url.pathname.slice("/api/git-credentials/".length)); if (await application.workspaces?.isCredentialAssigned(id)) { json(response, 409, { error: "Git credential is assigned to a session workspace. Close or remove that session assignment before deleting it." }); return; } await application.gitCredentials.delete(id); json(response, 200, { deleted: true }); } catch (error) { respondWorkspaceError(response, error); } return; }
  if (request.method === "GET" && url.pathname === "/api/targets") { json(response, 200, { targets: targets.map(({ endpoint: _endpoint, ...descriptor }) => descriptor) }); return; }
  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const ids = application.conversations?.openSessionIds() ?? [];
    const tasks = application.tasks ? await application.tasks.list() : [];
    const summaries = await Promise.all(ids.map(async (id) => { const session = await application.conversations?.getSession(id); const task = tasks.find((entry) => entry.sessionId === id); const job = application.promptSubmission?.jobs.latest(id); return { sessionId: id, ...(job ? { job: { id: job.id, mode: job.mode ?? "agent", status: job.status, title: job.input.slice(0, 160), ...(job.historyBaseMessageCount === undefined ? {} : { historyBaseMessageCount: job.historyBaseMessageCount }), updatedAt: job.updatedAt } } : {}), target: session?.target ?? targetId, ...(session?.model ? { model: session.model } : {}), status: job?.status ?? task?.status ?? sessionStatus(session?.history ?? []), createdAt: session?.createdAt, updatedAt: task?.updatedAt ?? session?.createdAt, state: session?.state, ...(task ? { task: { id: task.id, objective: task.objective.slice(0, 160), status: task.status, ...(task.development ? { phase: task.development.phase, currentAction: task.development.currentAction, attention: task.development.attention ? attentionFor({ status: task.status, reason: task.development.attention.reason }) : attentionFor({ status: task.status }) } : { attention: attentionFor({ status: task.status }) }) } } : {}) }; }));
    json(response, 200, { sessions: summaries.filter((session) => session.state === "open") }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/approvals/pending") { json(response, 200, { approvals: application.pendingApprovals?.pendingRequests() ?? [] }); return; }
  if (request.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/capabilities")) { const sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/capabilities".length)); if (!application.inspectSessionCapabilities) { json(response, 404, { error: "Capability inspection is unavailable." }); return; } try { json(response, 200, await application.inspectSessionCapabilities(sessionId)); } catch (error) { json(response, 404, { error: error instanceof Error ? error.message : "Session capability inspection failed." }); } return; }
  const gateway = application.gateway;
  if (targetId !== "local") { const target = targets.find((candidate) => candidate.id === targetId); if (!target?.endpoint) { json(response, 404, { error: "Target not found." }); return; } await proxyTarget(target.endpoint, request, url, response); return; }
  if (request.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/task")) { const sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/task".length)); const task = application.tasks ? await application.tasks.get(sessionId) : undefined; if (!task) { json(response, 404, { error: "Task was not found." }); return; } json(response, 200, task); return; }
  if ((request.method === "PATCH" || request.method === "DELETE") && url.pathname.startsWith("/api/providers/")) { if (!application.providers) { json(response, 404, { error: "Provider management is unavailable." }); return; } const id = decodeURIComponent(url.pathname.slice("/api/providers/".length)); try { if (request.method === "DELETE") await application.providers.delete(id); else await application.providers.update(id, (await readJson(request) ?? {}) as Partial<Omit<ProviderConfig, "id" | "type">>); json(response, 200, { updated: request.method === "PATCH", deleted: request.method === "DELETE" }); } catch (error) { json(response, 404, { error: error instanceof Error ? error.message : "Provider operation failed." }); } return; }
  if (request.method === "GET" && url.pathname === "/api/providers") { if (!application.providers) { json(response, 200, { providers: [] }); return; } json(response, 200, { providers: await application.providers.describe() }); return; }
  if (request.method === "POST" && url.pathname === "/api/providers/test") { if (!application.providers) { json(response, 404, { error: "Provider management is unavailable." }); return; } const body = await readJson(request); try { const result = await application.providers.test(body as unknown as ProviderConfig); json(response, 200, { ok: true, modelCount: result.models.length, models: result.models }); } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : "Provider test failed." }); } return; }
  if (request.method === "POST" && url.pathname === "/api/providers") { if (!application.providers) { json(response, 404, { error: "Provider management is unavailable." }); return; } try { await application.providers.create((await readJson(request)) as unknown as ProviderConfig); json(response, 201, { created: true }); } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : "Provider could not be created." }); } return; }
  if (request.method === "GET" && url.pathname === "/api/node") { json(response, 200, { node: application.node ?? { version: "unknown" }, capabilities: application.node?.capabilities ?? [], executionTargets: await describeExecutionTargets(application.executionTargets) }); return; }
  if (request.method === "GET" && url.pathname === "/api/execution-targets") { json(response, 200, { targets: await describeExecutionTargets(application.executionTargets) }); return; }
  if (request.method === "GET" && url.pathname === "/api/delegated-tasks") { json(response, 200, { tasks: application.delegatedTasks?.list(principal) ?? [] }); return; }
  if (request.method === "GET" && url.pathname.startsWith("/api/delegated-tasks/")) { const id = decodeURIComponent(url.pathname.slice("/api/delegated-tasks/".length)); const task = application.delegatedTasks?.getForPrincipal(id, principal); if (!task) { json(response, 404, { error: "Delegated task was not found." }); return; } json(response, 200, task); return; }
  if (request.method === "POST" && url.pathname.startsWith("/api/delegated-tasks/") && url.pathname.endsWith("/cancel")) { const id = decodeURIComponent(url.pathname.slice("/api/delegated-tasks/".length, -"/cancel".length)); try { json(response, 200, await application.delegatedTasks!.cancelForPrincipal(id, principal)); } catch (error) { json(response, 404, { error: error instanceof Error ? error.message : "Delegated task was not found." }); } return; }
  if (request.method === "GET" && url.pathname === "/api/tasks") { if (!application.tasks) { json(response, 200, { tasks: [] }); return; } const tasks = await application.tasks.list(); json(response, 200, { tasks: tasks.map((task) => ({ id: task.id, sessionId: task.sessionId, version: task.version, objective: task.objective.slice(0, 160), status: task.status, ...(task.failureReason ? { failureReason: task.failureReason } : {}), ...(task.development ? { developmentPhase: task.development.phase, phase: task.development.phase, currentAction: task.development.currentAction, pendingIntervention: task.development.pendingIntervention, image: task.development.image, deployment: task.development.deployment, executionRecords: task.development.executionRecords, attention: task.development.attention ? attentionFor({ status: task.status, reason: task.development.attention.reason }) : attentionFor({ status: task.status }) } : { attention: attentionFor({ status: task.status }) }), goal: task.objective, createdAt: task.createdAt, updatedAt: task.updatedAt, deletable: task.status !== "active" && task.status !== "blocked" })) }); return; }
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
    if (targetId !== "local" || principal.kind !== "human") { json(response, 403, { error: "SESSION_WORKSPACE_PERMISSION_DENIED" }); return; }
    const rawModel = body?.model && typeof body.model === "object" ? body.model as Record<string, unknown> : undefined;
    let model = rawModel && typeof rawModel.provider === "string" && typeof rawModel.model === "string" ? { provider: rawModel.provider, model: rawModel.model, ...(typeof rawModel.connectionId === "string" ? { connectionId: rawModel.connectionId } : {}), ...(typeof rawModel.modelRef === "string" ? { modelRef: rawModel.modelRef } : {}) } : undefined;
    if (model && application.modelCatalog) { const available = await application.modelCatalog(); const selected = available.find((option) => optionMatchesSelection(option, model!)); if (!selected) { json(response, 400, { error: "Selected model is not currently available." }); return; } model = { ...model, ...(selected.capabilities ? { capabilities: selected.capabilities } : {}) }; }
    if (body?.repository !== undefined && typeof body.repository !== "string") { json(response, 400, { error: "Repository must be a URL or supported Git remote." }); return; }
    if (body?.savedProjectId !== undefined && typeof body.savedProjectId !== "string") { json(response, 400, { error: "Saved project ID is invalid." }); return; }
    if (body?.repository && body.savedProjectId) { json(response, 400, { error: "Choose a repository to clone or a saved project to reopen, not both." }); return; }
    if (body?.credentialIds !== undefined && (!Array.isArray(body.credentialIds) || body.credentialIds.some((id) => typeof id !== "string"))) { json(response, 400, { error: "Git credential selection is invalid." }); return; }
    const isNewSession = typeof body?.sessionId !== "string";
    const sessionId = isNewSession ? randomUUID() : body!.sessionId as string;
    if (!isNewSession && (body?.repository || body?.savedProjectId || body?.gitCredential || body?.credentialIds)) { json(response, 400, { error: "Workspace options are only accepted when creating a new session." }); return; }
    let sessionCredentialId: string | undefined;
    const setupController = new AbortController();
    request.once("aborted", () => setupController.abort());
    response.once("close", () => { if (!response.writableEnded) setupController.abort(); });
    try {
      if (body?.gitCredential !== undefined) {
        if (!isNewSession || !application.gitCredentials) throw new Error("Session credentials can only be supplied when creating a new local session.");
        const credential = parseGitCredential(body.gitCredential, "session", sessionId);
        sessionCredentialId = (await application.gitCredentials.create(credential)).id;
      }
      if (body?.repository || body?.savedProjectId || (Array.isArray(body?.credentialIds) && body.credentialIds.length) || sessionCredentialId) {
        if (!application.workspaces) throw new Error("Session workspaces are unavailable.");
      }
      if (application.workspaces) await application.workspaces.createForSession(sessionId, { ...(typeof body?.repository === "string" && body.repository ? { repository: body.repository } : {}), ...(typeof body?.savedProjectId === "string" ? { savedProjectId: body.savedProjectId } : {}), credentialIds: [...(Array.isArray(body?.credentialIds) ? body.credentialIds as string[] : []), ...(sessionCredentialId ? [sessionCredentialId] : [])], signal: setupController.signal });
      const events = await collect(gateway.execute({ type: "CreateSession", target: targetId, sessionId, ...((model ?? application.modelSelection) ? { model: model ?? application.modelSelection } : {}) }, {}));
      const created = events.find((event): event is Extract<KernelEvent, { type: "SessionCreated" }> => event.type === "SessionCreated");
      if (created) { const workspaceSummary = await application.workspaces?.summaryForSession(sessionId); json(response, 200, { ...created, ...(workspaceSummary ? { workspace: workspaceSummary } : {}) }); }
      else { if (isNewSession) await application.workspaces?.deleteSessionWorkspace(sessionId, "delete").catch(() => undefined); if (sessionCredentialId) await application.gitCredentials?.delete(sessionCredentialId).catch(() => undefined); json(response, 400, events.find((event) => event.type === "Error") ?? { error: "Could not create session." }); }
    } catch (error) { if (isNewSession) await application.workspaces?.deleteSessionWorkspace(sessionId, "delete").catch(() => undefined); if (sessionCredentialId) await application.gitCredentials?.delete(sessionCredentialId).catch(() => undefined); respondWorkspaceError(response, error); }
    return;
  }
  if (parts.length >= 3 && parts[1] === "sessions") {
    const sessionId = decodeURIComponent(parts[2]!);
    if (request.method === "GET" && parts.length === 4 && parts[3] === "workspace") { const session = await application.conversations?.getSession(sessionId); if (!session) { json(response, 404, { error: "Session was not found." }); return; } const workspace = await application.workspaces?.summaryForSession(sessionId); if (!workspace) { json(response, 404, { error: "Session workspace was not found." }); return; } json(response, 200, { workspace }); return; }
    if (request.method === "GET" && parts.length === 3) {
      const session = await application.conversations?.getSession(sessionId);
      if (!session) { json(response, 404, { error: "Session was not found." }); return; }
      const requestedJob = url.searchParams.get("job");
      const job = requestedJob ? application.promptSubmission?.jobs.store.get(requestedJob) : application.promptSubmission?.jobs.latest(sessionId);
      if (requestedJob && (!job || job.sessionId !== sessionId)) { json(response, 404, { error: "Job was not found for this session." }); return; }
      const jobs = application.promptSubmission?.jobs.sessionHistory(sessionId).map((entry) => ({ id: entry.id, mode: entry.mode ?? "agent", status: entry.status, ...(entry.historyBaseMessageCount === undefined ? {} : { historyBaseMessageCount: entry.historyBaseMessageCount }), createdAt: entry.createdAt, title: entry.input.slice(0, 80) })) ?? [];
      const task = await application.tasks?.get(sessionId);
      json(response, 200, { id: session.id, state: session.state, ...(await application.workspaces?.summaryForSession(sessionId) ? { workspace: await application.workspaces?.summaryForSession(sessionId) } : {}), jobs, ...(job ? { job: { id: job.id, mode: job.mode ?? "agent", status: job.status, ...(job.historyBaseMessageCount === undefined ? {} : { historyBaseMessageCount: job.historyBaseMessageCount }), activity: job.activity, failure: job.failure, verification: job.verification, checks: job.checks, truncated: job.truncated, updatedAt: job.updatedAt } } : {}), status: job?.status ?? task?.status ?? sessionStatus(session.history ?? []), createdAt: session.createdAt, ...(session.target ? { target: session.target } : {}), ...(session.model ? { model: session.model } : {}), history: session.history });
      return;
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "messages") {
      const body = await readJson(request);
      if (typeof body?.input !== "string" || !body.input.trim()) { json(response, 400, { error: "input is required" }); return; }
      if (application.promptSubmission) {
        try { const receipt = await application.promptSubmission.submit({ content: body.input, sessionId, mode: body.mode === "agent" ? "agent" : "chat", idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : randomUUID() }, principal); json(response, 202, receipt); }
        catch (error) { json(response, 409, { error: error instanceof Error ? error.message : "Job submission failed" }); }
        return;
      }
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
      await application.promptSubmission?.jobs.cancelSession(sessionId);
      await collect(gateway.execute({ type: "CancelExecution", sessionId }, {}));
      json(response, 204, null);
      return;
    }
    if (request.method === "DELETE" && parts.length === 3) {
      if (application.promptSubmission?.jobs.store.list().some((job) => job.sessionId === sessionId && ["queued", "running", "needs_attention"].includes(job.status))) { json(response, 409, { error: "Cancel active jobs before deleting this session." }); return; }
      const body = await readJson(request); const disposition = body?.disposition;
      if (application.workspaces && disposition !== "keep" && disposition !== "delete") { json(response, 400, { error: "Choose whether to keep the project, delete its files, or cancel." }); return; }
      const session = await application.conversations?.getSession(sessionId); if (!session || session.state !== "open") { json(response, 404, { error: "Session was not found." }); return; }
      let savedProjectId: string | undefined;
      if (application.workspaces && (disposition === "keep" || disposition === "delete")) savedProjectId = (await application.workspaces.deleteSessionWorkspace(sessionId, disposition)).savedProjectId;
      await application.gitCredentials?.deleteSessionCredentials(sessionId);
      await collect(gateway.execute({ type: "CloseSession", sessionId }, {}));
      json(response, 200, { deleted: true, ...(savedProjectId ? { savedProjectId } : {}) });
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

function parseGitCredential(value: unknown, scope: "global" | "session", sessionId?: string): GitCredentialInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessFailure({ code: "VALIDATION_FAILED", message: "Git credential is invalid.", retryable: false });
  const body = value as Record<string, unknown>;
  if (typeof body.name !== "string" || (body.type !== "ssh" && body.type !== "https")) throw new HarnessFailure({ code: "VALIDATION_FAILED", message: "Git credential metadata is invalid.", retryable: false });
  if (body.type === "ssh") {
    if (typeof body.privateKey !== "string" || typeof body.knownHosts !== "string" || (body.publicKey !== undefined && typeof body.publicKey !== "string") || (body.sshConfig !== undefined && typeof body.sshConfig !== "string")) throw new HarnessFailure({ code: "VALIDATION_FAILED", message: "SSH credential files are invalid.", retryable: false });
    return { name: body.name, type: "ssh", scope, ...(sessionId ? { sessionId } : {}), privateKey: body.privateKey, knownHosts: body.knownHosts, ...(typeof body.publicKey === "string" ? { publicKey: body.publicKey } : {}), ...(typeof body.sshConfig === "string" ? { sshConfig: body.sshConfig } : {}) };
  }
  if (typeof body.username !== "string" || typeof body.password !== "string") throw new HarnessFailure({ code: "VALIDATION_FAILED", message: "HTTPS credential fields are invalid.", retryable: false });
  return { name: body.name, type: "https", scope, ...(sessionId ? { sessionId } : {}), username: body.username, password: body.password };
}
function respondWorkspaceError(response: ServerResponse, error: unknown): void {
  const known = error instanceof HarnessFailure ? error.error : undefined;
  const status = known?.code === "AUTHORIZATION_DENIED" || known?.code === "POLICY_VIOLATION" ? 403 : known?.code === "VALIDATION_FAILED" ? 400 : known?.code === "TIMEOUT" ? 504 : known?.code === "CAPABILITY_UNAVAILABLE" ? 502 : known ? 409 : 500;
  json(response, status, { error: known?.message ?? "Workspace operation failed.", ...(known ? { code: known.code } : {}) });
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
function remoteApplicationFor(application: WebApplication, targetId: string): RemoteApplicationGateway | undefined { return application.executionTargets?.resolve(targetId)?.application; }
async function federatedNodes(application: WebApplication, targets: readonly PortaTarget[], cache: Map<string, FederatedNodeCache>): Promise<readonly unknown[]> {
  const localTasks = application.tasks ? await application.tasks.list() : [];
  const local = { id: "local", displayName: "Local", kind: "local", available: true, stale: false, nodeIdentity: application.identity?.public.identity, capabilities: application.node?.capabilities ?? [], attentionCount: application.pendingApprovals?.pendingRequests().length ?? 0, activeTaskCount: localTasks.filter((task) => task.status === "active" || task.status === "blocked").length };
  const configured = new Map<string, PortaTarget>(targets.filter((entry) => entry.id !== "local").map((entry) => [entry.id, entry]));
  for (const target of application.executionTargets?.list() ?? []) if (!configured.has(target.id)) configured.set(target.id, { id: target.id, displayName: target.id, kind: "remote" });
  const remoteNodes = [];
  for (const target of configured.values()) {
    const remote = remoteApplicationFor(application, target.id); const prior = cache.get(target.id);
    try { if (!remote) throw new Error("NODE_NOT_KNOWN"); const description = await remote.describe(); cache.set(target.id, { sourceNodeId: target.id, lastSeenAt: new Date().toISOString(), stale: false, description }); remoteNodes.push({ id: target.id, displayName: target.displayName, kind: "remote", available: true, stale: false, lastSeenAt: new Date().toISOString(), ...description }); }
    catch (error) { remoteNodes.push({ id: target.id, displayName: target.displayName, kind: "remote", available: false, stale: true, lastSeenAt: prior?.lastSeenAt, ...(prior?.description ?? {}), error: error instanceof Error ? error.message : "NODE_UNAVAILABLE" }); }
  }
  return [local, ...remoteNodes];
}
async function describeExecutionTargets(registry?: TargetRegistry): Promise<readonly unknown[]> { if (!registry) return []; return Promise.all(registry.list().map(async (target) => { const available = await target.available(); let capabilities: readonly string[] = []; try { capabilities = await target.capabilities(); } catch {} return { id: target.id, kind: target.kind, available, capabilities, ...(target.workspace ? { workspaceId: target.workspace.id } : {}) }; })); }

function json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); if (status !== 204) response.end(JSON.stringify(value)); else response.end(); }
