import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { ApplicationGateway, KernelCommand, KernelEvent } from "./contracts.js";

export interface WebApplication {
  gateway: ApplicationGateway;
}

export interface WebServerOptions {
  host?: string;
  port?: number;
  webRoot?: string;
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export function createPortaWebServer(application: WebApplication, options: WebServerOptions = {}) {
  const webRoot = options.webRoot ?? join(process.cwd(), "web");
  const server = createServer((request, response) => void route(application.gateway, webRoot, request, response));
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

async function route(gateway: ApplicationGateway, webRoot: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      await api(gateway, url, request, response);
      return;
    }
    await staticFile(webRoot, url.pathname, response);
  } catch (error) {
    if (response.headersSent) response.end();
    else json(response, 500, { error: error instanceof Error ? error.message : "Request failed." });
  }
}

async function api(gateway: ApplicationGateway, url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "POST" && parts.length === 2 && parts[1] === "sessions") {
    const body = await readJson(request);
    const events = await collect(gateway.execute({ type: "CreateSession", ...(typeof body?.sessionId === "string" ? { sessionId: body.sessionId } : {}) }, {}));
    const created = events.find((event): event is Extract<KernelEvent, { type: "SessionCreated" }> => event.type === "SessionCreated");
    if (created) json(response, 200, created);
    else json(response, 400, events.find((event) => event.type === "Error") ?? { error: "Could not create session." });
    return;
  }
  if (parts.length >= 3 && parts[1] === "sessions") {
    const sessionId = decodeURIComponent(parts[2]!);
    if (request.method === "POST" && parts.length === 4 && parts[3] === "messages") {
      const body = await readJson(request);
      if (typeof body?.input !== "string" || !body.input.trim()) { json(response, 400, { error: "input is required" }); return; }
      response.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "application/x-ndjson; charset=utf-8", "Connection": "keep-alive" });
      request.on("close", () => void collect(gateway.execute({ type: "CancelExecution", sessionId }, {})));
      for await (const event of gateway.execute({ type: "SubmitInput", sessionId, input: body.input.trim() }, {})) {
        response.write(`${JSON.stringify(event)}\n`);
      }
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
function json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); if (status !== 204) response.end(JSON.stringify(value)); else response.end(); }
