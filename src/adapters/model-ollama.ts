import { z } from "zod";
import { CapabilityDescriptor, ComponentContext, failure, HarnessFailure, HarnessPlugin, HealthCheckable, HealthStatus, ModelContext, ModelDescriptor, ModelEvent, ModelProvider, ModelRequest, PluginRegistrar } from "../contracts.js";

export interface OllamaModelProviderConfig { baseUrl: string; model: string; timeoutMs?: number }
export const ollamaModelProviderConfigSchema = z.object({ baseUrl: z.string().url(), model: z.string().min(1), timeoutMs: z.number().int().positive().optional() });
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const ollamaMessageSchema = z.object({ role: z.string().optional(), content: z.string().optional() });
const ollamaStreamEventSchema = z.object({ message: ollamaMessageSchema.optional(), done: z.boolean() });
const ollamaErrorSchema = z.object({ error: z.string().optional() });
const ollamaTagsSchema = z.object({ models: z.array(z.object({ name: z.string().optional(), model: z.string().optional() })) });

const capability: CapabilityDescriptor = { id: "model.streaming", version: "1" };
const textCapability: CapabilityDescriptor = { id: "model.text", version: "1" };

export function mapRequestToOllama(request: ModelRequest, model: string): OllamaChatRequest {
  return { model, messages: [{ role: "user", content: request.input }], stream: true };
}

export function mapOllamaChunk(value: unknown): ModelEvent | undefined {
  const parsed = ollamaStreamEventSchema.safeParse(value);
  if (!parsed.success) throw failure("MODEL_FAILED", "Ollama returned a malformed stream event.", false, { issues: parsed.error.issues });
  if (parsed.data.done) return { type: "completed" };
  const content = parsed.data.message?.content;
  if (content === undefined) throw failure("MODEL_FAILED", "Ollama returned a stream event without message content.");
  return content.length > 0 ? { type: "delta", text: content } : undefined;
}

export class OllamaModelProvider implements ModelProvider, HealthCheckable {
  readonly descriptor: ModelDescriptor = { id: "ollama", version: "1", capabilities: [textCapability, capability] };
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
      for await (const record of readNdjson(response.body)) {
        const event = mapOllamaChunk(record);
        if (!event) continue;
        if (event.type === "completed") { completed = true; yield event; break; }
        yield event;
      }
      if (!completed) throw failure("MODEL_FAILED", "Ollama ended the stream before completion.");
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
      const available = tags.data.models.some((model) => model.name === this.config.model || model.model === this.config.model);
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

interface OllamaChatRequest { model: string; messages: readonly { role: "user"; content: string }[]; stream: true }

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
