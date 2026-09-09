import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { InstanceIdentityStore, LoginService } from "./identity.js";
import type { ExecutionTargetCapability } from "./target.js";
import type { JsonValue, ToolContext, ToolProvider, ToolResult } from "./contracts.js";
import type { GitBackend } from "./git.js";
import type { ImageAdapter } from "./deployment.js";

export type TargetOperation = "filesystem.read" | "filesystem.write" | "filesystem.delete" | "execution.run" | "git.commit" | "git.push" | "image.build" | "image.push";
export interface TargetDescription { readonly id: string; readonly kind: string; readonly available: boolean; readonly capabilities: readonly ExecutionTargetCapability[]; readonly workspace?: { readonly id: string; readonly path: string; readonly repository?: string }; readonly platform?: string }
export interface TargetOperationRequest { readonly requestId: string; readonly targetId: string; readonly workspaceId: string; readonly operation: TargetOperation; readonly input: unknown; readonly deadline?: number }
export interface TargetOperationResult { readonly requestId: string; readonly targetId: string; readonly workspaceId?: string; readonly operation: TargetOperation; readonly status: "completed" | "failed" | "cancelled" | "timed-out"; readonly output?: unknown; readonly error?: { readonly code: string; readonly message: string }; readonly startedAt: string; readonly finishedAt: string }
export interface TargetTransport { describe(signal?: AbortSignal): Promise<TargetDescription>; invoke(request: TargetOperationRequest, signal?: AbortSignal): Promise<TargetOperationResult>; cancel(requestId: string): Promise<void> }

export interface TargetAuthenticator { authenticate(targetId: string, challenge: string, signature: string): Promise<boolean> }
export interface HttpTargetTransportOptions { readonly endpoint: string; readonly clientIdentity: InstanceIdentityStore; readonly fetcher?: typeof fetch }
export interface TargetTransportServerOptions { readonly target: TargetDescription; readonly identity: InstanceIdentityStore; readonly operations: TargetTransport; readonly allowedIdentities?: readonly { readonly identity: string; readonly publicKey: string; readonly algorithm: "ed25519" }[] }

export class HttpTargetTransport implements TargetTransport {
  private token?: string;
  constructor(private readonly options: HttpTargetTransportOptions) {}
  async describe(signal?: AbortSignal): Promise<TargetDescription> { return this.request<TargetDescription>("GET", "/target/description", undefined, signal, false); }
  async invoke(request: TargetOperationRequest, signal?: AbortSignal): Promise<TargetOperationResult> { return this.request<TargetOperationResult>("POST", "/target/invoke", request, signal, true); }
  async cancel(requestId: string): Promise<void> { await this.request("POST", "/target/cancel", { requestId }, undefined, true); }
  private async request<T>(method: string, path: string, body: unknown, signal: AbortSignal | undefined, authenticated: boolean): Promise<T> {
    if (authenticated && !this.token) await this.authenticate(signal);
    const headers: Record<string, string> = { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(authenticated && this.token ? { authorization: `Bearer ${this.token}` } : {}) };
    let response = await (this.options.fetcher ?? fetch)(new URL(path, this.options.endpoint), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
    if (response.status === 401 && authenticated && this.token) { this.token = undefined; await this.authenticate(signal); response = await (this.options.fetcher ?? fetch)(new URL(path, this.options.endpoint), { method, headers: { ...headers, authorization: `Bearer ${this.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal }); }
    const payload = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Target transport returned HTTP ${response.status}.`);
    return payload;
  }
  private async authenticate(signal?: AbortSignal): Promise<void> {
    const challengeResponse = await (this.options.fetcher ?? fetch)(new URL("/target/auth/challenge", this.options.endpoint), { method: "POST", signal });
    if (!challengeResponse.ok) throw new Error(`Target authentication challenge failed (HTTP ${challengeResponse.status}).`);
    const challenge = await challengeResponse.json() as { challengeId: string; nonce: string; issuedAt: string; expiresAt: string; serverIdentity: { identity: string; publicKey: string; algorithm: "ed25519" } };
    const proof = { challengeId: challenge.challengeId, identity: this.options.clientIdentity.public.identity, signature: this.options.clientIdentity.sign(challenge) };
    const verified = await (this.options.fetcher ?? fetch)(new URL("/target/auth/verify", this.options.endpoint), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proof), signal });
    const payload = await verified.json() as { token?: string; error?: string };
    if (!verified.ok || !payload.token) throw new Error(payload.error ?? "Target authentication failed.");
    this.token = payload.token;
  }
}

export function createTargetTransportServer(options: TargetTransportServerOptions) {
  const login = new LoginService(options.identity);
  for (const allowed of options.allowedIdentities ?? []) options.identity.allow(allowed, "target-client");
  const server = createServer((request, response) => void handleTargetRequest(request, response, options, login));
  return { server, listen(host = "127.0.0.1", port = 0): Promise<{ host: string; port: number }> { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); const address = server.address(); if (!address || typeof address === "string") return reject(new Error("Target transport address unavailable.")); resolve({ host, port: address.port }); }); }); }, close(): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

async function handleTargetRequest(request: IncomingMessage, response: ServerResponse, options: TargetTransportServerOptions, login: LoginService): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/target/description") return send(response, 200, options.target);
    if (request.method === "POST" && url.pathname === "/target/auth/challenge") return send(response, 200, login.challenge());
    if (request.method === "POST" && url.pathname === "/target/auth/verify") { const body = await readBody(request) as { challengeId?: string; identity?: string; signature?: string }; if (!body.challengeId || !body.identity || !body.signature) return send(response, 400, { error: "TARGET_AUTHENTICATION_INVALID" }); try { return send(response, 200, login.login({ challengeId: body.challengeId, identity: body.identity, signature: body.signature })); } catch { return send(response, 401, { error: "TARGET_AUTHENTICATION_FAILED" }); } }
    if (!authenticateRequest(login, request)) return send(response, 401, { error: "TARGET_AUTHENTICATION_REQUIRED" });
    if (request.method === "POST" && url.pathname === "/target/invoke") return send(response, 200, await options.operations.invoke(await readBody(request) as TargetOperationRequest));
    if (request.method === "POST" && url.pathname === "/target/cancel") { const body = await readBody(request) as { requestId?: string }; if (body.requestId) await options.operations.cancel(body.requestId); return send(response, 204, undefined); }
    return send(response, 404, { error: "TARGET_ROUTE_NOT_FOUND" });
  } catch (error) { return send(response, 500, { error: error instanceof Error ? error.message : "TARGET_TRANSPORT_FAILED" }); }
}
function authenticateRequest(login: LoginService, request: IncomingMessage): boolean { const authorization = request.headers.authorization; return Boolean(authorization?.startsWith("Bearer ") && login.authenticateToken(authorization.slice(7).trim())); }
async function readBody(request: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; for await (const chunk of request) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).byteLength > 1024 * 1024) throw new Error("Target request is too large."); } return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
function send(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "content-type": "application/json" }); if (status === 204) response.end(); else response.end(JSON.stringify(value)); }
export interface TargetAuthenticationProof { readonly targetId: string; readonly challenge: string; readonly identity: string; readonly signature: string }

/** Client-side authenticated transport seam. The transport implementation owns the wire protocol. */
export class AuthenticatedTargetTransport implements TargetTransport {
  private authenticated = false;
  constructor(private readonly transport: TargetTransport, private readonly proof: TargetAuthenticationProof, private readonly authenticate: (proof: TargetAuthenticationProof) => Promise<boolean>) {}
  async describe(signal?: AbortSignal): Promise<TargetDescription> { await this.ensureAuthenticated(); return this.transport.describe(signal); }
  async invoke(request: TargetOperationRequest, signal?: AbortSignal): Promise<TargetOperationResult> { await this.ensureAuthenticated(); return this.transport.invoke(request, signal); }
  cancel(requestId: string): Promise<void> { return this.transport.cancel(requestId); }
  private async ensureAuthenticated(): Promise<void> { if (this.authenticated) return; if (!await this.authenticate(this.proof)) throw new Error("TARGET_AUTHENTICATION_FAILED"); this.authenticated = true; }
}

/** Adapts existing Porta tool providers to the target protocol; no filesystem or runtime logic is duplicated. */
export class ToolProviderTargetTransport implements TargetTransport {
  private readonly cancellations = new Map<string, AbortController>();
  constructor(private readonly description: TargetDescription, private readonly providers: Readonly<{ filesystem?: ToolProvider; execution?: ToolProvider; git?: GitBackend; image?: ImageAdapter }>, private readonly deleteFile?: (path: string) => Promise<unknown>) {}
  async describe(): Promise<TargetDescription> { return this.description; }
  async invoke(request: TargetOperationRequest): Promise<TargetOperationResult> {
    const startedAt = new Date().toISOString(); const controller = new AbortController(); this.cancellations.set(request.requestId, controller);
    if (request.operation === "filesystem.delete" && this.deleteFile) { try { const output = await this.deleteFile(String((request.input as { path?: unknown }).path ?? "")); return this.result(request, "completed", startedAt, undefined, output); } catch (error) { return this.result(request, "failed", startedAt, { code: "CAPABILITY_UNAVAILABLE", message: error instanceof Error ? error.message : "Filesystem deletion failed." }); } }
    if (["git.commit", "git.push", "image.build", "image.push"].includes(request.operation)) return this.invokeRelease(request, startedAt, controller);
    const provider = request.operation.startsWith("filesystem.") ? this.providers.filesystem : this.providers.execution;
    const toolId = request.operation === "filesystem.read" ? "read_file" : request.operation === "filesystem.write" ? "write_file" : request.operation === "execution.run" ? "run" : undefined;
    if (!provider || !toolId) return this.result(request, "failed", startedAt, { code: "CAPABILITY_UNAVAILABLE", message: "Target operation is unavailable." });
    try { const context: ToolContext = { traceId: `target-${request.requestId}`, sessionId: `target-${this.description.id}`, executionId: request.requestId, signal: controller.signal, ...(request.deadline === undefined ? {} : { deadline: request.deadline }) }; const result = await provider.invoke({ schemaVersion: 1, requestId: request.requestId, toolId, input: request.input as JsonValue }, context); const status = controller.signal.aborted ? "cancelled" as const : request.deadline !== undefined && request.deadline <= Date.now() ? "timed-out" as const : result.ok ? "completed" as const : "failed" as const; return this.result(request, status, startedAt, result.ok ? undefined : result.error, result.ok ? result.output : undefined); }
    finally { this.cancellations.delete(request.requestId); }
  }
  async cancel(requestId: string): Promise<void> { this.cancellations.get(requestId)?.abort(); }
  private async invokeRelease(request: TargetOperationRequest, startedAt: string, controller: AbortController): Promise<TargetOperationResult> {
    try {
      const input = request.input as Record<string, unknown>;
      const context = { signal: controller.signal, ...(request.deadline === undefined ? {} : { deadline: request.deadline }) };
      let output: unknown;
      if (request.operation === "git.commit" && this.providers.git?.commit) output = await this.providers.git.commit({ message: String(input.message ?? ""), ...(typeof input.expectedRevision === "string" ? { expectedRevision: input.expectedRevision } : {}) }, context);
      else if (request.operation === "git.push" && this.providers.git?.push) output = await this.providers.git.push(context);
      else if (request.operation === "image.build" && this.providers.image) output = await this.providers.image.build(String(input.sourceRevision ?? ""), String(input.tag ?? ""));
      else if (request.operation === "image.push" && this.providers.image) output = await this.providers.image.push(input as never);
      else return this.result(request, "failed", startedAt, { code: "CAPABILITY_UNAVAILABLE", message: "Target release operation is unavailable." });
      return this.result(request, controller.signal.aborted ? "cancelled" : "completed", startedAt, undefined, output);
    } catch (error) { return this.result(request, controller.signal.aborted ? "cancelled" : "failed", startedAt, { code: "TARGET_RELEASE_FAILED", message: error instanceof Error ? error.message : "Target release operation failed." }); }
  }
  private result(request: TargetOperationRequest, status: TargetOperationResult["status"], startedAt: string, error?: { readonly code: string; readonly message: string }, output?: unknown): TargetOperationResult { return { requestId: request.requestId, targetId: request.targetId, workspaceId: request.workspaceId, operation: request.operation, status, ...(output === undefined ? {} : { output }), ...(error ? { error } : {}), startedAt, finishedAt: new Date().toISOString() }; }
}

/** Deterministic transport fixture with an independent workspace and bounded operations. */
export class InMemoryTargetTransport implements TargetTransport {
  private readonly files = new Map<string, string>();
  private readonly cancelled = new Set<string>();
  constructor(private readonly description: TargetDescription, files: Readonly<Record<string, string>> = {}) { for (const [path, content] of Object.entries(files)) this.files.set(path, content); }
  async describe(): Promise<TargetDescription> { return this.description; }
  async invoke(request: TargetOperationRequest): Promise<TargetOperationResult> {
    const startedAt = new Date().toISOString();
    if (this.cancelled.has(request.requestId)) return this.result(request, "cancelled", startedAt, { code: "CANCELLED", message: "Target operation was cancelled." });
    if (request.deadline !== undefined && request.deadline <= Date.now()) return this.result(request, "timed-out", startedAt, { code: "TIMEOUT", message: "Target operation deadline expired." });
    try {
      const input = request.input as { path?: string; content?: string; command?: string };
      if (request.operation !== "execution.run" && (!input.path || input.path.startsWith("/") || input.path.includes(".."))) throw new Error("TARGET_PATH_OUTSIDE_WORKSPACE");
      if (request.operation === "filesystem.read") { const content = this.files.get(input.path!); if (content === undefined) throw new Error("TARGET_FILE_NOT_FOUND"); return this.result(request, "completed", startedAt, undefined, { path: input.path, content }); }
      if (request.operation === "filesystem.write") { if (typeof input.content !== "string") throw new Error("TARGET_CONTENT_REQUIRED"); this.files.set(input.path!, input.content); return this.result(request, "completed", startedAt, undefined, { path: input.path, written: true }); }
      if (request.operation === "filesystem.delete") { this.files.delete(input.path!); return this.result(request, "completed", startedAt, undefined, { path: input.path, deleted: true }); }
      if (request.operation === "execution.run") { if (input.command !== "pwd" && input.command !== "node --version" && input.command !== "git --version" && input.command !== "docker --version") throw new Error("TARGET_COMMAND_NOT_ALLOWED"); return this.result(request, "completed", startedAt, undefined, { command: input.command, cwd: this.description.workspace?.path ?? "" }); }
      throw new Error("TARGET_OPERATION_UNSUPPORTED");
    } catch (error) { return this.result(request, "failed", startedAt, { code: "TARGET_OPERATION_FAILED", message: error instanceof Error ? error.message : "Target operation failed." }); }
  }
  async cancel(requestId: string): Promise<void> { this.cancelled.add(requestId); }
  private result(request: TargetOperationRequest, status: TargetOperationResult["status"], startedAt: string, error?: TargetOperationResult["error"], output?: unknown): TargetOperationResult { return { requestId: request.requestId, targetId: request.targetId, workspaceId: request.workspaceId, operation: request.operation, status, ...(output === undefined ? {} : { output }), ...(error ? { error } : {}), startedAt, finishedAt: new Date().toISOString() }; }
}

export function targetRequest(targetId: string, workspaceId: string, operation: TargetOperation, input: unknown, deadline?: number): TargetOperationRequest { return { requestId: randomUUID(), targetId, workspaceId, operation, input, ...(deadline === undefined ? {} : { deadline }) }; }
