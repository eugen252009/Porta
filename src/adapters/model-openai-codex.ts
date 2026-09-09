import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { failure, HarnessFailure, jsonValueSchema, type HarnessPlugin, type HealthCheckable, type HealthStatus, type JsonValue, type ModelContext, type ModelDescriptor, type ModelOption, type ModelEvent, type ModelProvider, type ModelRequest, type ModelToolCall } from "../contracts.js";
import { CodexAuth, codexLoginHint, type CodexAuthSource } from "./codex-auth.js";

export const openAICodexModelProviderConfigSchema = z.object({
  model: z.string().min(1),
  timeoutMs: z.number().int().positive().max(2147483647).default(120000),
  maxResponseBytes: z.number().int().positive().max(64 * 1024 * 1024).default(8 * 1024 * 1024),
});
export type OpenAICodexModelProviderConfig = z.input<typeof openAICodexModelProviderConfigSchema>;
/** Provider-owned fallback catalog used when the subscription API does not expose model discovery. */
export const codexModelOptions: readonly ModelOption[] = [
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", provider: "openai-codex" },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", provider: "openai-codex" },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", provider: "openai-codex" },
  { id: "gpt-5.6-astra", displayName: "GPT-5.6 Astra", provider: "openai-codex" },
  { id: "gpt-4o", displayName: "GPT-4o", provider: "openai-codex" },
  { id: "o3-mini", displayName: "o3-mini", provider: "openai-codex" },
  { id: "gpt-4o-mini", displayName: "GPT-4o mini", provider: "openai-codex" },
];
export type CodexFetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
const capabilities = [{ id: "model.text", version: "1" }, { id: "model.streaming", version: "1" }, { id: "model.tools", version: "1" }];
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const nativeCallId = (id: string) => `call_${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
const malformed = () => failure("MODEL_FAILED", "Codex returned a malformed or incomplete response.");

/** Pure Responses mapping. Provider-scoped tool IDs remain canonical; only wire names are escaped. */
export function mapRequestToCodex(request: ModelRequest, model: string): JsonValue {
  const names = new Map((request.tools ?? []).map((tool, index) => [tool.id, `harness_tool_${index}`]));
  const name = (id: string) => names.get(id) ?? `unavailable_${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
  const input: JsonValue[] = [];
  if (!request.messages?.length) input.push({ role: "user", content: request.input });
  for (const message of request.messages ?? []) {
    if (message.role === "user") input.push({ role: "user", content: message.content });
    else if (message.role === "assistant") {
      if (message.content) input.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
      for (const call of message.toolCalls ?? []) input.push({ type: "function_call", call_id: nativeCallId(call.id), name: name(call.toolId), arguments: JSON.stringify(call.input) });
    } else input.push({ type: "function_call_output", call_id: nativeCallId(message.toolCallId), output: JSON.stringify(message.result.error ? { error: message.result.error, output: message.result.output } : message.result.output) });
  }
  return {
    model, instructions: (request.control ?? []).map((message) => message.content).join("\n\n") || "You are a helpful assistant.",
    input, store: false, stream: true, parallel_tool_calls: false,
    tools: (request.tools ?? []).map((tool) => ({ type: "function", name: name(tool.id), description: tool.description ?? tool.name, parameters: tool.inputSchema, strict: false })),
  };
}

const eventSchema = z.object({ type: z.string() });
const textSchema = z.object({ delta: z.string() });
const itemSchema = z.object({ item: z.object({ type: z.string() }).passthrough() });
const callSchema = z.object({ type: z.literal("function_call"), call_id: z.string().min(1), name: z.string().min(1), arguments: z.string() });
const completedSchema = z.object({ response: z.object({ status: z.literal("completed"), output: z.array(z.object({ type: z.string() }).passthrough()) }) });

export class OpenAICodexModelProvider implements ModelProvider, HealthCheckable {
  readonly descriptor: ModelDescriptor = { id: "openai-codex", version: "1", capabilities };
  private readonly config: z.output<typeof openAICodexModelProviderConfigSchema>;
  constructor(config: OpenAICodexModelProviderConfig, private readonly auth: CodexAuthSource = new CodexAuth(), private readonly fetchLike: CodexFetchLike = fetch) {
    this.config = openAICodexModelProviderConfigSchema.parse(config);
  }

  async *generate(request: ModelRequest, context: ModelContext): AsyncIterable<ModelEvent> {
    const control = new AbortController();
    let reason: "cancelled" | "timeout" | undefined;
    const abort = () => { if (!reason) reason = "cancelled"; control.abort(); };
    const remaining = Math.min(this.config.timeoutMs, context.deadline === undefined ? this.config.timeoutMs : context.deadline - Date.now());
    if (context.signal.aborted) abort();
    else if (remaining <= 0) { reason = "timeout"; control.abort(); }
    else context.signal.addEventListener("abort", abort, { once: true });
    const timer = control.signal.aborted ? undefined : setTimeout(() => { if (!reason) reason = "timeout"; control.abort(); }, remaining);
    let response: Response | undefined;
    try {
      control.signal.throwIfAborted();
      const body = JSON.stringify(mapRequestToCodex(request, this.config.model));
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw failure("VALIDATION_FAILED", "Codex request exceeds the 4 MiB input limit.");
      const credential = await this.auth.getAccess(control.signal);
      control.signal.throwIfAborted();
      response = await this.fetchLike(endpoint, {
        method: "POST", redirect: "error", signal: control.signal,
        headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${credential.access}`, "chatgpt-account-id": credential.accountId, "OpenAI-Beta": "responses=experimental", originator: "porta" }, body,
      });
      control.signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) throw failure("AUTHORIZATION_DENIED", `Codex rejected this account or its credentials. ${codexLoginHint}`);
      if (!response.ok) throw failure("MODEL_FAILED", `Codex returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500, { status: response.status });
      if (!response.body) throw malformed();
      const mapping = new Map((request.tools ?? []).map((tool, index) => [`harness_tool_${index}`, tool.id]));
      const calls = new Map<string, { raw: z.infer<typeof callSchema>; call: ModelToolCall }>();
      const pendingCalls = new Set<string>();
      const addCall = (value: unknown) => {
        const raw = callSchema.parse(value);
        const toolId = mapping.get(raw.name);
        if (!toolId) throw malformed();
        const input = jsonValueSchema.parse(JSON.parse(raw.arguments));
        pendingCalls.delete(raw.call_id);
        const previous = calls.get(raw.call_id);
        if (previous) {
          if (JSON.stringify(previous.raw) !== JSON.stringify(raw)) throw malformed();
          return;
        }
        if (calls.size >= 128) throw failure("MODEL_FAILED", "Codex response exceeds the 128 tool-call limit.");
        calls.set(raw.call_id, { raw, call: { id: `codex-tool-${randomUUID()}`, toolId, input } });
      };
      for await (const value of readCodexSSE(response.body, this.config.maxResponseBytes, control.signal)) {
        const event = eventSchema.parse(value);
        if (event.type === "response.output_text.delta") yield { type: "delta", text: textSchema.parse(value).delta };
        else if (event.type === "response.output_item.added") {
          const { item } = itemSchema.parse(value);
          if (item.type === "function_call") {
            const raw = callSchema.parse(item);
            if (calls.has(raw.call_id) || pendingCalls.has(raw.call_id)) throw malformed();
            pendingCalls.add(raw.call_id);
            if (pendingCalls.size + calls.size > 128) throw failure("MODEL_FAILED", "Codex response exceeds the 128 tool-call limit.");
          }
        } else if (event.type === "response.output_item.done") {
          const { item } = itemSchema.parse(value);
          if (item.type === "function_call") addCall(item);
        } else if (event.type === "response.completed" || event.type === "response.done") {
          const { response: completed } = completedSchema.parse(value);
          const finalCalls = completed.output.filter((item) => item.type === "function_call");
          for (const item of finalCalls) addCall(item);
          // Codex may send output: [] on success after delivering authoritative
          // output_item.done events. A nonempty final output must still agree
          // with those events; an empty summary must not discard completed calls.
          if (pendingCalls.size || completed.output.length > 0 && (new Set(finalCalls.map((item) => item.call_id)).size !== calls.size || finalCalls.length !== calls.size)) throw malformed();
          control.signal.throwIfAborted();
          // Never execute partial calls before successful completion of the entire response.
          for (const { call } of calls.values()) yield { type: "tool-call", call };
          yield { type: "completed" };
          return;
        } else if (["error", "response.failed", "response.incomplete"].includes(event.type)) throw failure("MODEL_FAILED", "Codex generation failed or exceeded the model's output limit.");
        // Reasoning and lifecycle events deliberately stay out of canonical history.
      }
      throw malformed();
    } catch (error) {
      if (reason === "cancelled") throw failure("CANCELLED", "Model generation was cancelled.");
      if (reason === "timeout") throw failure("TIMEOUT", "Codex generation exceeded its deadline or timeout.", true);
      if (error instanceof HarnessFailure) throw error;
      // Never expose response bodies, OAuth tokens, or arbitrary transport error text.
      throw failure("MODEL_FAILED", "Codex request failed or returned a malformed response.");
    } finally {
      control.abort();
      if (timer !== undefined) clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }

  /** Credential readiness only: does not claim model entitlement or spend subscription quota. */
  async health(): Promise<HealthStatus> {
    const signal = AbortSignal.timeout(Math.min(this.config.timeoutMs, 15000));
    try { await this.auth.getAccess(signal); return { status: "healthy", message: "Codex credentials are ready; model access is checked on generation." }; }
    catch { return { status: "unhealthy", reason: signal.aborted ? "timeout" : "configuration-invalid", message: `Codex credentials are unavailable. ${codexLoginHint}` }; }
  }
}

export function createOpenAICodexPlugin(provider: OpenAICodexModelProvider): HarnessPlugin {
  return { manifest: { schemaVersion: 1, id: "model.openai-codex", version: "1", provides: capabilities, requires: [] }, register(registrar) { for (const capability of capabilities) registrar.provide(capability, provider); } };
}

/** Bounded SSE decoder with multiline data, split UTF-8, cancellation, and reader cleanup. */
async function* readCodexSSE(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal): AsyncIterable<unknown> {
  const reader = body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = ""; let data: string[] = []; let bytes = 0;
  const parse = () => { const raw = data.join("\n"); data = []; if (raw === "[DONE]") throw malformed(); return JSON.parse(raw) as unknown; };
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await reader.read();
      signal.throwIfAborted();
      bytes += result.value?.byteLength ?? 0;
      if (bytes > maxBytes) throw failure("MODEL_FAILED", "Codex response exceeds the configured byte limit.");
      buffer += decoder.decode(result.value, { stream: !result.done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
        if (line === "") { if (data.length) yield parse(); }
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (result.done) { if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, "")); if (data.length) yield parse(); return; }
    }
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
