import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HarnessFailure, ModelEvent, ModelMessage, ModelProvider, ModelRequest, ModelToolCall, ModelOption, ToolDescriptor, JsonValue } from "./contracts.js";
import { withModelIdentity } from "./model-identity.js";

export interface OpenAIAPIApplication {
  modelCatalog: () => Promise<readonly ModelOption[]>;
  modelCatalogForAPI?: () => Promise<{ models: readonly ModelOption[]; failures: readonly string[] }>;
  resolveModel: (requested?: string) => Promise<ModelProvider>;
}

interface ChatRequest {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  temperature?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
}

interface PreparedRequest {
  externalModel: string;
  modelRequest: ModelRequest;
  tools: readonly ToolDescriptor[];
}

export async function handleOpenAIModels(application: Pick<OpenAIAPIApplication, "modelCatalog" | "modelCatalogForAPI">, response: ServerResponse): Promise<void> {
  try {
    const catalog = application.modelCatalogForAPI ? await application.modelCatalogForAPI() : { models: await application.modelCatalog(), failures: [] as readonly string[] };
    const data = catalog.models.map((model) => ({ id: `${model.provider}/${model.id}`, object: "model" as const }));
    writeJSON(response, 200, { object: "list", data, ...(catalog.failures.length ? { warnings: catalog.failures.map((provider) => ({ provider, status: "unavailable" })) } : {}) });
  } catch (error) {
    writeError(response, 503, "model_catalog_unavailable", "Model catalog is unavailable.", error);
  }
}

export async function handleOpenAIChat(application: OpenAIAPIApplication, request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>): Promise<void> {
  let prepared: PreparedRequest;
  try {
    prepared = await prepareRequest(application, body);
  } catch (error) {
    const mapped = mapError(error);
    writeError(response, mapped.status, mapped.code, mapped.message, error);
    return;
  }

  const controller = new AbortController();
  request.on("aborted", () => controller.abort());
  response.on("close", () => { if (!response.writableEnded) controller.abort(); });
  let model: ModelProvider;
  try {
    model = await application.resolveModel(prepared.externalModel);
  } catch (error) {
    const mapped = mapError(error);
    writeError(response, mapped.status, mapped.code, mapped.message, error);
    return;
  }

  const stream = body.stream === true;
  const context = { traceId: randomUUID(), sessionId: `openai-${randomUUID()}`, executionId: randomUUID(), signal: controller.signal };
  try {
    if (stream) await writeStreamingCompletion(model, prepared, context, response, controller);
    else await writeCompletion(model, prepared, context, response);
  } catch (error) {
    const mapped = mapError(error);
    if (response.headersSent) {
      if (!response.writableEnded) {
        if (stream) {
          response.write(`data: ${JSON.stringify({ error: { message: mapped.message, type: mapped.type, code: mapped.code } })}\n\n`);
          response.write("data: [DONE]\n\n");
        }
        response.end();
      }
    } else writeError(response, mapped.status, mapped.code, mapped.message, error);
  }
}

async function prepareRequest(application: OpenAIAPIApplication, body: Record<string, unknown>): Promise<PreparedRequest> {
  const externalModel = requireString(body.model, "model");
  if (!externalModel.includes("/")) throw apiFailure(400, "invalid_model", "model must use a qualified provider/model identifier.");
  const catalog = application.modelCatalogForAPI ? await application.modelCatalogForAPI() : { models: await application.modelCatalog(), failures: [] as readonly string[] };
  if (!catalog.models.some((model) => withModelIdentity(model).ref === externalModel || `${model.provider}/${model.id}` === externalModel)) throw apiFailure(catalog.failures.length ? 503 : 404, catalog.failures.length ? "provider_unavailable" : "model_not_found", catalog.failures.length ? "A model provider is unavailable." : `The model '${externalModel}' is not currently available.`);
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw apiFailure(400, "invalid_messages", "messages must be a non-empty array.");
  const parsedMessages = body.messages.map((value, index) => parseMessage(value, index));
  const messages = parsedMessages.flatMap((parsed) => parsed.message ? [parsed.message] : []);
  const control = parsedMessages.flatMap((parsed) => parsed.control ? [parsed.control] : []);
  const temperature = parseTemperature(body.temperature);
  const tools = parseTools(body.tools, body.tool_choice);
  const input = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  return { externalModel, tools, modelRequest: { schemaVersion: 1, requestId: randomUUID(), input, messages, ...(control.length ? { control } : {}), ...(temperature === undefined ? {} : { temperature }), ...(tools.length ? { tools } : {}) } };
}

function parseMessage(value: unknown, index: number): { message?: ModelMessage; control?: { role: "system"; content: string } } {
  if (!value || typeof value !== "object") throw apiFailure(400, "invalid_messages", `messages[${index}] must be an object.`);
  const message = value as Record<string, unknown>;
  const role = message.role;
  if (role === "system") {
    const content = requireString(message.content, `messages[${index}].content`);
    return { control: { role: "system", content } };
  }
  if (role === "user") return { message: { role, content: requireString(message.content, `messages[${index}].content`) } };
  if (role === "assistant") return { message: { role, ...(message.content === undefined || message.content === null ? {} : { content: requireString(message.content, `messages[${index}].content`) }) } };
  throw apiFailure(400, "unsupported_message_role", `messages[${index}].role '${String(role)}' is not supported.`);
}

function parseTemperature(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) throw apiFailure(400, "invalid_temperature", "temperature must be a finite number between 0 and 2.");
  return value;
}

function parseTools(value: unknown, choice: unknown): readonly ToolDescriptor[] {
  if (choice !== undefined && choice !== "auto" && choice !== "none") throw apiFailure(400, "unsupported_tool_choice", "Only tool_choice 'auto' and 'none' are supported.");
  if (choice === "none") return [];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw apiFailure(400, "invalid_tools", "tools must be an array.");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw apiFailure(400, "invalid_tools", `tools[${index}] must be an object.`);
    const tool = entry as Record<string, unknown>;
    const fn = tool.function;
    if (tool.type !== "function" || !fn || typeof fn !== "object") throw apiFailure(400, "invalid_tools", `tools[${index}] must be a function tool.`);
    const definition = fn as Record<string, unknown>;
    const name = requireString(definition.name, `tools[${index}].function.name`);
    const parameters = definition.parameters;
    if (!parameters || typeof parameters !== "object") throw apiFailure(400, "invalid_tools", `tools[${index}].function.parameters is required.`);
    return { id: name, name, version: "1", ...(definition.description === undefined ? {} : { description: requireString(definition.description, `tools[${index}].function.description`) }), inputSchema: parameters as JsonValue };
  });
}

async function writeCompletion(model: ModelProvider, prepared: PreparedRequest, context: { traceId: string; sessionId: string; executionId: string; signal: AbortSignal }, response: ServerResponse): Promise<void> {
  const events = await collectEvents(model.generate(prepared.modelRequest, context));
  const text = events.filter((event): event is Extract<ModelEvent, { type: "delta" }> => event.type === "delta").map((event) => event.text).join("");
  const calls = events.filter((event): event is Extract<ModelEvent, { type: "tool-call" }> => event.type === "tool-call").map((event) => event.call);
  writeJSON(response, 200, { id: `chatcmpl-${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: prepared.externalModel, choices: [{ index: 0, message: { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls.map(toOpenAIToolCall) } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }] });
}

async function writeStreamingCompletion(model: ModelProvider, prepared: PreparedRequest, context: { traceId: string; sessionId: string; executionId: string; signal: AbortSignal }, response: ServerResponse, controller: AbortController): Promise<void> {
  const id = `chatcmpl-${randomUUID()}`;
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
  response.flushHeaders?.();
  writeSSE(response, { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: prepared.externalModel, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  const calls: ModelToolCall[] = [];
  try {
    for await (const event of model.generate(prepared.modelRequest, context)) {
      if (event.type === "delta") writeSSE(response, { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: prepared.externalModel, choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }] });
      else if (event.type === "tool-call") { calls.push(event.call); writeSSE(response, { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: prepared.externalModel, choices: [{ index: 0, delta: { tool_calls: [toOpenAIToolCall(event.call)] }, finish_reason: null }] }); }
    }
    writeSSE(response, { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: prepared.externalModel, choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] });
    response.write("data: [DONE]\n\n");
    response.end();
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    throw apiFailure(499, "cancelled", "The request was cancelled.");
  }
}

function toOpenAIToolCall(call: ModelToolCall): Record<string, unknown> { return { id: call.id, type: "function", function: { name: call.toolId, arguments: JSON.stringify(call.input) } }; }
async function collectEvents(source: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> { const events: ModelEvent[] = []; for await (const event of source) events.push(event); return events; }
function writeSSE(response: ServerResponse, value: unknown): void { response.write(`data: ${JSON.stringify(value)}\n\n`); }
function requireString(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw apiFailure(400, "invalid_request", `${field} must be a non-empty string.`); return value; }
function writeJSON(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); }
function writeError(response: ServerResponse, status: number, code: string, message: string, cause?: unknown): void { const mapped = mapError(cause); writeJSON(response, status, { error: { message, type: mapped.type, code } }); }
function apiFailure(status: number, code: string, message: string): Error & { api: true; status: number; code: string } { return Object.assign(new Error(message), { api: true as const, status, code }); }
function mapError(error: unknown): { status: number; code: string; type: string; message: string } {
  if (error && typeof error === "object" && "api" in error && (error as { api?: boolean }).api) { const value = error as unknown as { status: number; code: string; message: string }; return { status: value.status, code: value.code, type: "invalid_request_error", message: value.message }; }
  const code = error instanceof HarnessFailure ? error.error.code : undefined;
  if (code === "CAPABILITY_UNAVAILABLE") return { status: 503, code: "provider_unavailable", type: "server_error", message: "The requested provider or model is unavailable." };
  if (code === "AUTHORIZATION_DENIED") return { status: 502, code: "provider_authentication_failed", type: "server_error", message: "The provider rejected authentication." };
  if (code === "TIMEOUT") return { status: 504, code: "provider_timeout", type: "server_error", message: "The provider request timed out." };
  if (code === "CANCELLED") return { status: 499, code: "cancelled", type: "invalid_request_error", message: "The request was cancelled." };
  if (code === "VALIDATION_FAILED") return { status: 400, code: "invalid_request", type: "invalid_request_error", message: "The provider rejected the request." };
  return { status: 502, code: "provider_error", type: "server_error", message: "The provider request failed." };
}
