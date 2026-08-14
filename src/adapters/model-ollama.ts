import { z } from "zod";
import { CapabilityDescriptor, ComponentContext, failure, HarnessFailure, HarnessPlugin, HealthCheckable, HealthStatus, JsonValue, ModelContext, ModelDescriptor, ModelEvent, ModelProvider, ModelRequest, ModelToolCall, PluginRegistrar, ToolDescriptor } from "../contracts.js";

export interface OllamaModelProviderConfig { baseUrl: string; model: string; timeoutMs?: number }
export const ollamaModelProviderConfigSchema = z.object({ baseUrl: z.string().url(), model: z.string().min(1), timeoutMs: z.number().int().positive().optional() });
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const ollamaMessageSchema = z.object({ role: z.string().optional(), content: z.string().optional(), tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.unknown() }) })).optional() });
const ollamaStreamEventSchema = z.object({ message: ollamaMessageSchema.optional(), done: z.boolean() });
const ollamaErrorSchema = z.object({ error: z.string().optional() });
const ollamaTagsSchema = z.object({ models: z.array(z.object({ name: z.string().optional(), model: z.string().optional(), capabilities: z.array(z.string()).optional(), details: z.object({ capabilities: z.array(z.string()).optional() }).optional() })) });

const capability: CapabilityDescriptor = { id: "model.streaming", version: "1" };
const textCapability: CapabilityDescriptor = { id: "model.text", version: "1" };
const toolsCapability: CapabilityDescriptor = { id: "model.tools", version: "1" };

export interface OllamaToolMapping { nativeName: string; canonicalId: string }
export function mapToolsToOllama(tools: readonly ToolDescriptor[]): { definitions: readonly OllamaToolDefinition[]; mappings: readonly OllamaToolMapping[] } {
  const mappings = tools.map((tool, index) => ({ nativeName: `harness_tool_${index}`, canonicalId: tool.id }));
  return { mappings, definitions: tools.map((tool, index) => ({ type: "function", function: { name: `harness_tool_${index}`, description: tool.description ?? tool.name, parameters: tool.inputSchema } })) };
}
export function mapRequestToOllama(request: ModelRequest, model: string): OllamaChatRequest {
  const mapped = mapToolsToOllama(request.tools ?? []); const mapping = new Map(mapped.mappings.map((entry) => [entry.nativeName, entry.canonicalId])); const tools = mapped.definitions;
  const messages: OllamaMessage[] = request.messages?.length ? [] : [{ role: "user", content: request.input }];
  for (const message of request.messages ?? []) {
    if (message.role === "user") messages.push({ role: "user", content: message.content });
    else if (message.role === "assistant") messages.push({ role: "assistant", ...(message.content ? { content: message.content } : {}), ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({ function: { name: [...mapping.entries()].find(([, id]) => id === call.toolId)?.[0] ?? call.toolId, arguments: call.input } })) } : {}) });
    else messages.push({ role: "tool", content: serializeToolResult(message.result), tool_name: [...mapping.entries()].find(([, id]) => id === message.toolId)?.[0] ?? message.toolId });
  }
  return { model, messages, stream: true, ...(tools.length ? { tools } : {}) };
}

export function mapOllamaChunk(value: unknown, mapping: ReadonlyMap<string, string> = new Map(), callIndex = 0): ModelEvent | undefined {
  const parsed = ollamaStreamEventSchema.safeParse(value);
  if (!parsed.success) throw failure("MODEL_FAILED", "Ollama returned a malformed stream event.", false, { issues: parsed.error.issues });
  if (parsed.data.message?.tool_calls?.length) {
    const calls = parsed.data.message.tool_calls;
    const call = calls[0]!; const canonicalId = mapping.get(call.function.name);
    if (!canonicalId || !isJsonValue(call.function.arguments)) throw failure("MODEL_FAILED", "Ollama returned an unknown or malformed tool call.");
    return { type: "tool-call", call: { id: `ollama-tool-${callIndex}`, toolId: canonicalId, input: call.function.arguments } };
  }
  if (parsed.data.done) return { type: "completed" };
  const content = parsed.data.message?.content;
  if (content === undefined) throw failure("MODEL_FAILED", "Ollama returned a stream event without message content.");
  return content.length > 0 ? { type: "delta", text: content } : undefined;
}

function mapOllamaEvents(value: unknown, mapping: ReadonlyMap<string, string>, callIndex: number): ModelEvent[] {
  const parsed = ollamaStreamEventSchema.safeParse(value); if (!parsed.success) throw failure("MODEL_FAILED", "Ollama returned a malformed stream event.", false, { issues: parsed.error.issues });
  const events: ModelEvent[] = []; const calls = parsed.data.message?.tool_calls ?? [];
  calls.forEach((call, index) => { const canonicalId = mapping.get(call.function.name); if (!canonicalId || !isJsonValue(call.function.arguments)) throw failure("MODEL_FAILED", "Ollama returned an unknown or malformed tool call."); events.push({ type: "tool-call", call: { id: `ollama-tool-${callIndex + index}`, toolId: canonicalId, input: call.function.arguments } }); });
  if (events.length) return events; const event = mapOllamaChunk(value, mapping, callIndex); return event ? [event] : [];
}

export class OllamaModelProvider implements ModelProvider, HealthCheckable {
  private toolSupport = false;
  get descriptor(): ModelDescriptor { return { id: "ollama", version: "1", capabilities: [textCapability, capability, ...(this.toolSupport ? [toolsCapability] : [])] }; }
  private readonly config: OllamaModelProviderConfig;
  private readonly fetch: FetchLike;

  constructor(config: OllamaModelProviderConfig, fetchLike: FetchLike = fetch) {
    this.config = ollamaModelProviderConfigSchema.parse(config);
    this.fetch = fetchLike;
  }

  async *generate(request: ModelRequest, context: ModelContext): AsyncIterable<ModelEvent> {
    const control = new AbortController();
    let reason: "cancelled" | "timeout" | undefined;
    const abort = () => { reason = "cancelled"; control.abort(); };
    if (context.signal.aborted) abort(); else context.signal.addEventListener("abort", abort, { once: true });
    const remaining = context.deadline === undefined ? undefined : context.deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) reason = "timeout";
    const timeout = remaining === undefined ? this.config.timeoutMs : this.config.timeoutMs === undefined ? remaining : Math.min(this.config.timeoutMs, remaining);
    const timer = timeout === undefined ? undefined : setTimeout(() => { reason = "timeout"; control.abort(); }, timeout);
    try {
      if (reason === "cancelled") throw failure("CANCELLED", "Model generation was cancelled.");
      if (reason === "timeout") throw failure("TIMEOUT", "Model generation exceeded its deadline or timeout.", true);
      let response: Response;
      try { response = await this.fetch(`${this.config.baseUrl.replace(/\/$/, "")}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(mapRequestToOllama(request, this.config.model)), signal: control.signal }); }
      catch (error) { throw this.mapTransportError(error, reason); }
      if (!response.ok) throw await this.mapHttpError(response);
      if (!response.body) throw failure("MODEL_FAILED", "Ollama returned no response body.");
      let completed = false;
      const mapping = new Map((request.tools ?? []).map((tool, index) => [`harness_tool_${index}`, tool.id])); const pendingCalls: ModelToolCall[] = [];
      for await (const record of readNdjson(response.body)) {
        const events = mapOllamaEvents(record, mapping, 0);
        for (const event of events) { if (event.type === "tool-call") { const index = pendingCalls.length; pendingCalls[index] = pendingCalls[index] ? { ...pendingCalls[index]!, input: mergeJsonObjects(pendingCalls[index]!.input, event.call.input) } : event.call; } else if (event.type === "completed") { completed = true; } else yield event; }
        if (completed) break;
      }
      if (!completed) throw failure("MODEL_FAILED", "Ollama ended the stream before completion.");
      for (const call of pendingCalls) yield callEvent(call);
      yield { type: "completed" };
    } catch (error) {
      if (error instanceof HarnessFailure) throw error;
      throw this.mapTransportError(error, reason);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
    }
  }

  async health(): Promise<HealthStatus> {
    const control = new AbortController();
    const timer = this.config.timeoutMs === undefined ? undefined : setTimeout(() => control.abort(), this.config.timeoutMs);
    try {
      let response: Response;
      try { response = await this.fetch(`${this.config.baseUrl.replace(/\/$/, "")}/api/tags`, { signal: control.signal }); }
      catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return { status: "unhealthy", reason: "timeout", message: "Ollama health check timed out." };
        return { status: "unhealthy", reason: "unreachable", message: "Ollama could not be reached." };
      }
      if (!response.ok) return { status: "unhealthy", reason: "provider-error", message: `Ollama health request returned HTTP ${response.status}.`, details: { status: response.status } };
      const tags = ollamaTagsSchema.safeParse(await response.json());
      if (!tags.success) return { status: "unhealthy", reason: "invalid-response", message: "Ollama returned a malformed model list." };
      const selected = tags.data.models.find((model) => model.name === this.config.model || model.model === this.config.model);
      const available = Boolean(selected);
      this.toolSupport = Boolean(selected?.capabilities?.includes("tools") || selected?.details?.capabilities?.includes("tools"));
      return available ? { status: "healthy" } : { status: "unhealthy", reason: "resource-unavailable", message: "The configured model is unavailable.", details: { resourceType: "model", resourceName: this.config.model } };
    } catch { return { status: "unhealthy", reason: "invalid-response", message: "Ollama returned an unreadable health response." }; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private async mapHttpError(response: Response): Promise<HarnessFailure> {
    let message = `Ollama returned HTTP ${response.status}.`;
    try { const body = ollamaErrorSchema.safeParse(await response.json()); if (body.success && body.data.error) message = body.data.error; } catch { /* retain generic HTTP diagnostic */ }
    return failure("MODEL_FAILED", message, response.status >= 500, { status: response.status });
  }
  private mapTransportError(error: unknown, reason?: "cancelled" | "timeout"): HarnessFailure {
    if (reason === "timeout") return failure("TIMEOUT", "Model generation exceeded its deadline or timeout.", true);
    if (reason === "cancelled" || (error instanceof DOMException && error.name === "AbortError")) return failure("CANCELLED", "Model generation was cancelled.");
    return failure("MODEL_FAILED", "Ollama could not be reached.", true, { cause: error instanceof Error ? error.message : "unknown transport failure" });
  }
}

export function createOllamaPlugin(provider: OllamaModelProvider): HarnessPlugin {
  return { manifest: { schemaVersion: 1, id: "model.ollama", version: "1", provides: [textCapability, capability], requires: [] }, register(registrar: PluginRegistrar) { registrar.provide(textCapability, provider); registrar.provide(capability, provider); }, initialize: async (_context: ComponentContext) => {} };
}

interface OllamaToolDefinition { type: "function"; function: { name: string; description: string; parameters: JsonValue } }
interface OllamaChatRequest { model: string; messages: readonly OllamaMessage[]; stream: true; tools?: readonly OllamaToolDefinition[] }
type OllamaMessage = { role: "user" | "assistant" | "tool"; content?: string; tool_name?: string; tool_calls?: readonly { function: { name: string; arguments: JsonValue } }[] };
function serializeToolResult(result: { output: JsonValue; error?: unknown }): string { return JSON.stringify(result.error ? { error: result.error, output: result.output } : result.output); }
function isJsonValue(value: unknown): value is JsonValue { return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || Array.isArray(value) && value.every(isJsonValue) || typeof value === "object" && value !== null && Object.values(value).every(isJsonValue); }
function mergeJsonObjects(left: JsonValue, right: JsonValue): JsonValue { if (typeof left === "object" && left !== null && !Array.isArray(left) && typeof right === "object" && right !== null && !Array.isArray(right)) return { ...left, ...right }; return right; }
function callEvent(call: ModelToolCall): ModelEvent { return { type: "tool-call", call }; }

async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (line) { try { yield JSON.parse(line); } catch { throw failure("MODEL_FAILED", "Ollama returned malformed JSON in its stream."); } } }
      if (result.done) break;
    }
    const finalLine = buffer.trim();
    if (finalLine) { try { yield JSON.parse(finalLine); } catch { throw failure("MODEL_FAILED", "Ollama returned malformed JSON in its stream."); } }
  } finally { reader.releaseLock(); }
}
