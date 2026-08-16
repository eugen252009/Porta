import { z } from "zod";
import { CapabilityDescriptor, ComponentContext, failure, HarnessFailure, HealthCheckable, HealthStatus, HarnessPlugin, JsonValue, ModelContext, ModelDescriptor, ModelEvent, ModelProvider, ModelRequest, ModelToolCall, PluginRegistrar, ToolDescriptor } from "../contracts.js";

export interface OpenAICompatibleModelProviderConfig { baseUrl: string; model: string; timeoutMs?: number; apiKey?: string }
export const openAICompatibleModelProviderConfigSchema = z.object({ baseUrl: z.string().url(), model: z.string().min(1), timeoutMs: z.number().int().positive().optional(), apiKey: z.string().min(1).optional() });
export type OpenAIFetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const toolCallFragmentSchema = z.object({ index: z.number().int().optional(), id: z.string().optional(), type: z.string().optional(), function: z.object({ name: z.string().optional(), arguments: z.string().nullable().optional() }).optional() });
const openAIStreamChunkSchema = z.object({ choices: z.array(z.object({ delta: z.object({ role: z.string().optional(), content: z.string().nullable().optional(), reasoning_content: z.string().optional(), tool_calls: z.array(toolCallFragmentSchema).optional() }).optional(), finish_reason: z.string().nullable().optional() })).optional() });
const openAIErrorBodySchema = z.object({ error: z.union([z.object({ message: z.string().optional() }), z.string()]).optional() });
const openAIModelListSchema = z.object({ data: z.array(z.object({ id: z.string().optional(), aliases: z.array(z.string()).optional() })) });

const textCapability: CapabilityDescriptor = { id: "model.text", version: "1" };
const streamingCapability: CapabilityDescriptor = { id: "model.streaming", version: "1" };
const toolsCapability: CapabilityDescriptor = { id: "model.tools", version: "1" };

export interface OpenAIToolMapping { nativeName: string; canonicalId: string }
export interface OpenAIToolDefinition { type: "function"; function: { name: string; description: string; parameters: JsonValue } }
export interface OpenAIAssistantMessage { role: "assistant"; content?: string; tool_calls?: readonly { id: string; type: "function"; function: { name: string; arguments: string } }[] }
export interface OpenAIChatRequest { model: string; messages: readonly OpenAIChatMessage[]; stream: true; tools?: readonly OpenAIToolDefinition[] }
export type OpenAIChatMessage = { role: "system" | "user"; content: string } | OpenAIAssistantMessage | { role: "tool"; tool_call_id: string; content: string; name?: string };
export interface OpenAIStreamState { toolCalls: Map<number, { id?: string; name: string; arguments: string }> }
export function createOpenAIStreamState(): OpenAIStreamState { return { toolCalls: new Map() }; }

export function mapToolsToOpenAI(tools: readonly ToolDescriptor[]): { definitions: readonly OpenAIToolDefinition[]; mappings: readonly OpenAIToolMapping[] } {
  const mappings = tools.map((tool, index) => ({ nativeName: `harness_tool_${index}`, canonicalId: tool.id }));
  return { mappings, definitions: tools.map((tool, index) => ({ type: "function", function: { name: `harness_tool_${index}`, description: tool.description ?? tool.name, parameters: tool.inputSchema } })) };
}

export function mapRequestToOpenAI(request: ModelRequest, model: string): OpenAIChatRequest {
  const mapped = mapToolsToOpenAI(request.tools ?? []); const byCanonical = new Map(mapped.mappings.map((entry) => [entry.canonicalId, entry.nativeName]));
  const messages: OpenAIChatMessage[] = (request.control ?? []).map((message) => ({ role: "system", content: message.content }));
  if (!request.messages?.length) messages.push({ role: "user", content: request.input });
  for (const message of request.messages ?? []) {
    if (message.role === "user") messages.push({ role: "user", content: message.content });
    else if (message.role === "assistant") messages.push({ role: "assistant", ...(message.content ? { content: message.content } : {}), ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: byCanonical.get(call.toolId) ?? "unknown_tool", arguments: JSON.stringify(call.input) } })) } : {}) });
    else messages.push({ role: "tool", tool_call_id: message.toolCallId, content: serializeToolResult(message.result), ...(byCanonical.has(message.toolId) ? { name: byCanonical.get(message.toolId) } : {}) });
  }
  return { model, messages, stream: true, ...(mapped.definitions.length ? { tools: mapped.definitions } : {}) };
}

/** Applies one OpenAI stream chunk to the accumulation state and returns the canonical events it produces. */
export function applyOpenAIStreamChunk(value: unknown, state: OpenAIStreamState, mapping: ReadonlyMap<string, string> = new Map()): ModelEvent[] {
  const parsed = openAIStreamChunkSchema.safeParse(value);
  if (!parsed.success) throw failure("MODEL_FAILED", "The OpenAI-compatible server returned a malformed stream chunk.", false, { issues: parsed.error.issues });
  const choice = parsed.data.choices?.[0]; if (!choice?.delta) return [];
  const delta = choice.delta; const events: ModelEvent[] = [];
  if (delta.content) events.push({ type: "delta", text: delta.content });
  for (const fragment of delta.tool_calls ?? []) {
    const index = fragment.index ?? state.toolCalls.size; const existing = state.toolCalls.get(index);
    state.toolCalls.set(index, { id: fragment.id ?? existing?.id, name: fragment.function?.name ?? existing?.name ?? "", arguments: (existing?.arguments ?? "") + (fragment.function?.arguments ?? "") });
  }
  return events;
}

/** Finalizes accumulated tool calls into canonical tool-call events, resolving native names back to canonical tool IDs. */
export function finishOpenAIToolCalls(state: OpenAIStreamState, mapping: ReadonlyMap<string, string>, idPrefix: string, nextId: () => number): ModelToolCall[] {
  const calls: ModelToolCall[] = [];
  for (const [index, fragment] of [...state.toolCalls.entries()].sort((left, right) => left[0] - right[0])) {
    const canonicalId = mapping.get(fragment.name);
    if (!canonicalId) throw failure("MODEL_FAILED", `The model returned a tool call for the unknown tool "${fragment.name}".`);
    calls.push({ id: `${idPrefix}-${nextId()}`, toolId: canonicalId, input: parseToolArguments(fragment.arguments) });
  }
  return calls;
}

function parseToolArguments(raw: string): JsonValue {
  if (!raw.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw failure("MODEL_FAILED", "The model returned malformed tool call arguments."); }
  if (!isJsonValue(value)) throw failure("MODEL_FAILED", "The model returned non-JSON tool call arguments.");
  return value;
}

export class OpenAICompatibleModelProvider implements ModelProvider, HealthCheckable {
  get descriptor(): ModelDescriptor { return { id: "openai-compatible", version: "1", capabilities: [textCapability, streamingCapability, toolsCapability] }; }
  private readonly config: OpenAICompatibleModelProviderConfig;
  private readonly fetch: OpenAIFetchLike;
  private nextToolCallId = 0;

  constructor(config: OpenAICompatibleModelProviderConfig, fetchLike: OpenAIFetchLike = fetch) {
    this.config = openAICompatibleModelProviderConfigSchema.parse(config);
    this.fetch = fetchLike;
  }

  private get apiRoot(): string { const root = this.config.baseUrl.replace(/\/+$/, ""); return root.endsWith("/v1") ? root : `${root}/v1`; }

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
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.config.apiKey) headers["authorization"] = `Bearer ${this.config.apiKey}`;
      let response: Response;
      try { response = await this.fetch(`${this.apiRoot}/chat/completions`, { method: "POST", headers, body: JSON.stringify(mapRequestToOpenAI(request, this.config.model)), signal: control.signal }); }
      catch (error) { throw this.mapTransportError(error, reason); }
      if (!response.ok) throw await this.mapHttpError(response);
      if (!response.body) throw failure("MODEL_FAILED", "The OpenAI-compatible server returned no response body.");
      const mapping = new Map((request.tools ?? []).map((tool, index) => [`harness_tool_${index}`, tool.id]));
      const state = createOpenAIStreamState();
      let completed = false;
      for await (const chunk of readSSE(response.body)) {
        if (chunk === null) { completed = true; break; }
        for (const event of applyOpenAIStreamChunk(chunk, state)) yield event;
      }
      if (!completed) throw failure("MODEL_FAILED", "The OpenAI-compatible server ended the stream without a completion marker.");
      for (const call of finishOpenAIToolCalls(state, mapping, "openai-tool", () => this.nextToolCallId++)) yield { type: "tool-call", call };
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
      try { response = await this.fetch(`${this.apiRoot}/models`, { signal: control.signal }); }
      catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return { status: "unhealthy", reason: "timeout", message: "The OpenAI-compatible health check timed out." };
        return { status: "unhealthy", reason: "unreachable", message: "The OpenAI-compatible server could not be reached." };
      }
      if (!response.ok) return { status: "unhealthy", reason: "provider-error", message: `The OpenAI-compatible health request returned HTTP ${response.status}.`, details: { status: response.status } };
      const models = openAIModelListSchema.safeParse(await response.json());
      if (!models.success) return { status: "unhealthy", reason: "invalid-response", message: "The OpenAI-compatible server returned a malformed model list." };
      const selected = models.data.data.find((model) => model.id === this.config.model || model.aliases?.includes(this.config.model));
      return selected ? { status: "healthy" } : { status: "unhealthy", reason: "resource-unavailable", message: "The configured model is unavailable.", details: { resourceType: "model", resourceName: this.config.model } };
    } catch { return { status: "unhealthy", reason: "invalid-response", message: "The OpenAI-compatible server returned an unreadable health response." }; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private async mapHttpError(response: Response): Promise<HarnessFailure> {
    let message = `The OpenAI-compatible server returned HTTP ${response.status}.`;
    try { const body = openAIErrorBodySchema.safeParse(await response.json()); if (body.success && body.data.error) message = typeof body.data.error === "string" ? body.data.error : body.data.error.message ?? message; } catch { /* retain generic HTTP diagnostic */ }
    return failure("MODEL_FAILED", message, response.status >= 500, { status: response.status });
  }
  private mapTransportError(error: unknown, reason?: "cancelled" | "timeout"): HarnessFailure {
    if (reason === "timeout") return failure("TIMEOUT", "Model generation exceeded its deadline or timeout.", true);
    if (reason === "cancelled" || (error instanceof DOMException && error.name === "AbortError")) return failure("CANCELLED", "Model generation was cancelled.");
    return failure("MODEL_FAILED", "The OpenAI-compatible server could not be reached.", true, { cause: error instanceof Error ? error.message : "unknown transport failure" });
  }
}

export function createOpenAICompatiblePlugin(provider: OpenAICompatibleModelProvider): HarnessPlugin {
  return { manifest: { schemaVersion: 1, id: "model.openai-compatible", version: "1", provides: [textCapability, streamingCapability, toolsCapability], requires: [] }, register(registrar: PluginRegistrar) { registrar.provide(textCapability, provider); registrar.provide(streamingCapability, provider); registrar.provide(toolsCapability, provider); }, initialize: async (_context: ComponentContext) => {} };
}

function serializeToolResult(result: { output: JsonValue; error?: unknown }): string { return JSON.stringify(result.error ? { error: result.error, output: result.output } : result.output); }
function isJsonValue(value: unknown): value is JsonValue { return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || Array.isArray(value) && value.every(isJsonValue) || typeof value === "object" && value !== null && Object.values(value).every(isJsonValue); }

/** Yields one parsed SSE data payload per event; yields `null` for the `[DONE]` marker. */
async function* readSSE(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "").trim();
        buffer = buffer.slice(newline + 1);
        if (!line || line.startsWith(":") || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { yield null; return; }
        try { yield JSON.parse(payload); } catch { throw failure("MODEL_FAILED", "The OpenAI-compatible server returned malformed JSON in its stream."); }
      }
      if (result.done) break;
    }
    const finalLine = buffer.replace(/\r$/, "").trim();
    if (finalLine.startsWith("data:")) {
      const payload = finalLine.slice(5).trim();
      if (payload === "[DONE]") { yield null; return; }
      try { yield JSON.parse(payload); } catch { throw failure("MODEL_FAILED", "The OpenAI-compatible server returned malformed JSON in its stream."); }
    }
  } finally { reader.releaseLock(); }
}
