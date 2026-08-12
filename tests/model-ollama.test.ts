import { describe, expect, it } from "vitest";
import { OllamaModelProvider, createOllamaPlugin, mapOllamaChunk, mapRequestToOllama, mapToolsToOllama, ollamaModelProviderConfigSchema } from "../src/adapters/model-ollama.js";
import { ModelEvent } from "../src/index.js";

const request = { schemaVersion: 1 as const, requestId: "request", input: "hello" };
const context = (signal = new AbortController().signal, deadline?: number) => ({ traceId: "trace", sessionId: "session", executionId: "execution", signal, deadline });
function stream(chunks: string[]): ReadableStream<Uint8Array> { const encoder = new TextEncoder(); return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }); }
function response(body: ReadableStream<Uint8Array> | null, status = 200, json?: unknown): Response { return { ok: status >= 200 && status < 300, status, body, json: async () => json } as Response; }
async function collect(source: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> { const result: ModelEvent[] = []; for await (const event of source) result.push(event); return result; }

describe("Ollama adapter", () => {
  it("validates configuration and maps canonical requests", () => {
    expect(ollamaModelProviderConfigSchema.parse({ baseUrl: "http://localhost:11434", model: "generic-model" })).toMatchObject({ model: "generic-model" });
    expect(() => ollamaModelProviderConfigSchema.parse({ baseUrl: "not-a-url", model: "generic-model" })).toThrow();
    expect(mapRequestToOllama(request, "generic-model")).toEqual({ model: "generic-model", messages: [{ role: "user", content: "hello" }], stream: true });
    expect(mapOllamaChunk({ message: { role: "assistant", content: "hi" }, done: false })).toEqual({ type: "delta", text: "hi" });
    expect(mapOllamaChunk({ done: true })).toEqual({ type: "completed" });
  });
  it("maps colliding provider-scoped tools to distinct native names", () => { const tools = [{ id: "server-a/echo", name: "echo", version: "1", inputSchema: {} }, { id: "server-b/echo", name: "echo", version: "1", inputSchema: {} }]; const mapped = mapToolsToOllama(tools); expect(mapped.mappings.map((entry) => entry.nativeName)).toEqual(["harness_tool_0", "harness_tool_1"]); expect(mapped.mappings.map((entry) => entry.canonicalId)).toEqual(["server-a/echo", "server-b/echo"]); });
  it("maps native tool calls back to canonical identity", () => { const event = mapOllamaChunk({ message: { tool_calls: [{ function: { name: "harness_tool_1", arguments: { value: "ok" } } }] }, done: false }, new Map([["harness_tool_1", "server-b/echo"]]))!; expect(event).toEqual({ type: "tool-call", call: { id: "ollama-tool-0", toolId: "server-b/echo", input: { value: "ok" } } }); });
  it("parses multiple records and records split across reads", async () => {
    const provider = new OllamaModelProvider({ baseUrl: "http://provider.test", model: "generic-model" }, async (_input, init) => { expect(init?.method).toBe("POST"); expect(JSON.parse(String(init?.body))).toMatchObject({ model: "generic-model" }); return response(stream([`{"message":{"content":"a"},"done":false}\n{"message":{"content":"b"},`, `"done":false}\n{"done":true}\n`])); });
    expect(await collect(provider.generate(request, context()))).toEqual([{ type: "delta", text: "a" }, { type: "delta", text: "b" }, { type: "completed" }]);
  });
  it("normalizes malformed streams and HTTP errors", async () => {
    const malformed = new OllamaModelProvider({ baseUrl: "http://provider.test", model: "generic-model" }, async () => response(stream(["not-json\n"])));
    await expect(collect(malformed.generate(request, context()))).rejects.toMatchObject({ error: { code: "MODEL_FAILED" } });
    const httpFailure = new OllamaModelProvider({ baseUrl: "http://provider.test", model: "generic-model" }, async () => response(null, 404, { error: "model missing" }));
    await expect(collect(httpFailure.generate(request, context()))).rejects.toMatchObject({ error: { code: "MODEL_FAILED", message: "model missing" } });
  });
  it("propagates cancellation to the underlying request", async () => {
    let requestSignal: AbortSignal | undefined; let rejectRequest: ((error: unknown) => void) | undefined;
    const provider = new OllamaModelProvider({ baseUrl: "http://provider.test", model: "generic-model" }, async (_input, init) => { requestSignal = init?.signal as AbortSignal; return new Promise<Response>((_resolve, reject) => { rejectRequest = reject; requestSignal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }); }); });
    const controller = new AbortController(); const pending = collect(provider.generate(request, context(controller.signal))); await new Promise((resolve) => setTimeout(resolve, 0)); controller.abort(); await expect(pending).rejects.toMatchObject({ error: { code: "CANCELLED" } }); expect(requestSignal?.aborted).toBe(true); rejectRequest?.(new Error("cleanup"));
  });
  it("distinguishes deadline timeout", async () => {
    let aborted = false;
    const provider = new OllamaModelProvider({ baseUrl: "http://provider.test", model: "generic-model" }, async (_input, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("timeout", "AbortError")); }, { once: true }); }));
    await expect(collect(provider.generate(request, context(new AbortController().signal, Date.now() + 5)))).rejects.toMatchObject({ error: { code: "TIMEOUT" } }); expect(aborted).toBe(true);
  });
  it("checks model availability without generation", async () => {
    const provider = new OllamaModelProvider({ baseUrl: "http://provider.test", model: "generic-model" }, async (input) => { expect(String(input)).toContain("/api/tags"); return response(null, 200, { models: [{ name: "generic-model" }] }); });
    expect(await provider.health()).toEqual({ status: "healthy" });
    expect(createOllamaPlugin(provider).manifest.provides.map((item) => item.id)).toEqual(["model.text", "model.streaming"]);
  });
  it("gates model.tools on selected model metadata", async () => { const provider = new OllamaModelProvider({ baseUrl: "http://provider.test", model: "generic-model" }, async () => response(null, 200, { models: [{ name: "generic-model", capabilities: ["completion", "tools"] }] })); await provider.health(); expect(provider.descriptor.capabilities.map((capability) => capability.id)).toContain("model.tools"); });
  it("reports generic health diagnostics", async () => {
    const unreachable = new OllamaModelProvider({ baseUrl: "http://provider.test", model: "generic-model" }, async () => { throw new Error("connection refused"); });
    expect(await unreachable.health()).toMatchObject({ status: "unhealthy", reason: "unreachable" });
    const missing = new OllamaModelProvider({ baseUrl: "http://provider.test", model: "missing-model" }, async () => response(null, 200, { models: [{ name: "other-model" }] }));
    expect(await missing.health()).toMatchObject({ status: "unhealthy", reason: "resource-unavailable", details: { resourceType: "model", resourceName: "missing-model" } });
    const malformed = new OllamaModelProvider({ baseUrl: "http://provider.test", model: "generic-model" }, async () => response(null, 200, { invalid: true }));
    expect(await malformed.health()).toMatchObject({ status: "unhealthy", reason: "invalid-response" });
  });
  it("reports health request timeouts", async () => {
    const provider = new OllamaModelProvider({ baseUrl: "http://provider.test", model: "generic-model", timeoutMs: 1 }, async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true })));
    expect(await provider.health()).toMatchObject({ status: "unhealthy", reason: "timeout" });
  });
});

const live = process.env.RUN_OLLAMA_INTEGRATION_TESTS === "1" ? describe : describe.skip;
live("Ollama live smoke", () => {
  it("streams a configured model", async () => {
    const provider = new OllamaModelProvider({ baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434", model: process.env.OLLAMA_MODEL ?? "" });
    expect((await provider.health()).status).toBe("healthy");
    const events = await collect(provider.generate(request, context())); expect(events.some((event) => event.type === "delta")).toBe(true); expect(events.at(-1)).toEqual({ type: "completed" });
  });
});
