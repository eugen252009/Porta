import { describe, expect, it } from "vitest";
import { applyOpenAIStreamChunk, createOpenAIStreamState, finishOpenAIToolCalls, mapRequestToOpenAI, mapToolsToOpenAI, openAICompatibleModelProviderConfigSchema, OpenAICompatibleModelProvider, createOpenAICompatiblePlugin } from "../src/adapters/model-openai-compatible.js";
import { ModelEvent, ModelToolCall, ToolDescriptor } from "../src/index.js";

const request = { schemaVersion: 1 as const, requestId: "request", input: "hello" };
const tools: readonly ToolDescriptor[] = [{ id: "server-a/echo", name: "echo", version: "1", inputSchema: { type: "object", properties: { value: { type: "string" } } } }, { id: "server-b/echo", name: "echo", version: "1", inputSchema: {} }];
const context = (signal = new AbortController().signal, deadline?: number) => ({ traceId: "trace", sessionId: "session", executionId: "execution", signal, deadline });
function stream(chunks: string[]): ReadableStream<Uint8Array> { const encoder = new TextEncoder(); return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }); }
function response(body: ReadableStream<Uint8Array> | null, status = 200, json?: unknown): Response { return { ok: status >= 200 && status < 300, status, body, json: async () => json } as Response; }
async function collect(source: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> { const result: ModelEvent[] = []; for await (const event of source) result.push(event); return result; }
const sse = (payload: string) => `data: ${payload}\n\n`;
const toolCall = (events: ModelEvent[]): ModelToolCall | undefined => (events.find((event) => event.type === "tool-call") as { call?: ModelToolCall } | undefined)?.call;

describe("OpenAI-compatible adapter", () => {
  it("validates configuration", () => {
    expect(openAICompatibleModelProviderConfigSchema.parse({ baseUrl: "http://127.0.0.1:8080", model: "local-model" })).toMatchObject({ model: "local-model" });
    expect(openAICompatibleModelProviderConfigSchema.parse({ baseUrl: "http://127.0.0.1:8080/v1", model: "local-model", apiKey: "secret" })).toMatchObject({ apiKey: "secret" });
    expect(() => openAICompatibleModelProviderConfigSchema.parse({ baseUrl: "not-a-url", model: "local-model" })).toThrow();
  });
  it("maps canonical requests including history and tools", () => {
    const mapped = mapRequestToOpenAI({ schemaVersion: 1, requestId: "request", input: "hello", control: [{ role: "system", content: "be concise" }], tools, messages: [
      { role: "user", content: "call both" },
      { role: "assistant", content: "", toolCalls: [{ id: "openai-tool-1", toolId: "server-a/echo", input: { value: "ok" } }] },
      { role: "tool", toolCallId: "openai-tool-1", toolId: "server-a/echo", result: { toolCallId: "openai-tool-1", toolId: "server-a/echo", output: { echoed: "ok" } } },
    ] }, "local-model");
    expect(mapped).toEqual({
      model: "local-model", stream: true,
      messages: [
        { role: "system", content: "be concise" },
        { role: "user", content: "call both" },
        { role: "assistant", tool_calls: [{ id: "openai-tool-1", type: "function", function: { name: "harness_tool_0", arguments: '{"value":"ok"}' } }] },
        { role: "tool", tool_call_id: "openai-tool-1", content: '{"echoed":"ok"}', name: "harness_tool_0" },
      ],
      tools: expect.arrayContaining([{ type: "function", function: { name: "harness_tool_0", description: "echo", parameters: tools[0]!.inputSchema } }]),
    });
  });
  it("maps colliding provider-scoped tools to distinct native names", () => {
    const mapped = mapToolsToOpenAI(tools);
    expect(mapped.mappings.map((entry) => entry.nativeName)).toEqual(["harness_tool_0", "harness_tool_1"]);
    expect(mapped.mappings.map((entry) => entry.canonicalId)).toEqual(["server-a/echo", "server-b/echo"]);
  });
  it("accumulates streamed tool call fragments and resolves canonical identity", () => {
    const state = createOpenAIStreamState();
    const events = [
      ...applyOpenAIStreamChunk({ choices: [{ delta: { content: "Let me check." } }] }, state),
      ...applyOpenAIStreamChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "harness_tool_1", arguments: '{"val' } }] } }] }, state),
      ...applyOpenAIStreamChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ue":"ok"}' } }] } }] }, state),
    ];
    expect(events).toEqual([{ type: "delta", text: "Let me check." }]);
    expect(finishOpenAIToolCalls(state, new Map([["harness_tool_1", "server-b/echo"]]), "openai-tool", () => 7)).toEqual([{ id: "openai-tool-7", toolId: "server-b/echo", input: { value: "ok" } }]);
  });
  it("streams text, ignores reasoning content, and completes on the marker", async () => {
    const provider = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model" }, async (_input, init) => { expect(init?.method).toBe("POST"); expect(JSON.parse(String(init?.body))).toMatchObject({ model: "local-model", stream: true }); return response(stream([sse('{"choices":[{"delta":{"role":"assistant","content":"a"}}]}'), sse('{"choices":[{"delta":{"content":"b","reasoning_content":"hidden thinking"}}]}'), "data: [DONE]\n\n"])); });
    expect(await collect(provider.generate(request, context()))).toEqual([{ type: "delta", text: "a" }, { type: "delta", text: "b" }, { type: "completed" }]);
  });
  it("emits tool calls after the completion marker with unique IDs across turns", async () => {
    const provider = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model" }, async () => response(stream([sse('{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"harness_tool_0","arguments":"{\\"value\\":\\"ok\\"}"}}]}}]}'), "data: [DONE]\n\n"])));
    const first = toolCall(await collect(provider.generate({ ...request, tools }, context())));
    const second = toolCall(await collect(provider.generate({ ...request, tools }, context())));
    expect(first).toMatchObject({ toolId: "server-a/echo", input: { value: "ok" } });
    expect(first?.id).not.toBe(second?.id);
  });
  it("parses SSE records split across reads", async () => {
    const provider = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model" }, async () => response(stream(['data: {"choices":[{"delta":{"con', 'tent":"a"}}]}\n\n' + sse('{"choices":[{"delta":{"content":"b"}}]}') + "data: [DO", "NE]\n\n"])));
    expect(await collect(provider.generate(request, context()))).toEqual([{ type: "delta", text: "a" }, { type: "delta", text: "b" }, { type: "completed" }]);
  });
  it("normalizes malformed streams and HTTP errors", async () => {
    const malformed = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model" }, async () => response(stream(["data: not-json\n\n"])));
    await expect(collect(malformed.generate(request, context()))).rejects.toMatchObject({ error: { code: "MODEL_FAILED" } });
    const unknownTool = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model" }, async () => response(stream([sse('{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"harness_tool_9","arguments":"{}"}}]}}]}'), "data: [DONE]\n\n"])));
    await expect(collect(unknownTool.generate(request, context()))).rejects.toMatchObject({ error: { code: "MODEL_FAILED", message: expect.stringContaining("unknown tool") } });
    const httpFailure = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model" }, async () => response(null, 404, { error: { message: "model not found" } }));
    await expect(collect(httpFailure.generate(request, context()))).rejects.toMatchObject({ error: { code: "MODEL_FAILED", message: "model not found" } });
  });
  it("sends the API key as a bearer token when configured", async () => {
    let headers: Record<string, string> | undefined;
    const provider = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model", apiKey: "secret" }, async (_input, init) => { headers = init?.headers as Record<string, string>; return response(stream([sse('{"choices":[{"delta":{"content":"ok"}}]}'), "data: [DONE]\n\n"])); });
    await collect(provider.generate(request, context()));
    expect(headers?.authorization).toBe("Bearer secret");
  });
  it("propagates cancellation to the underlying request", async () => {
    let requestSignal: AbortSignal | undefined;
    const provider = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model" }, async (_input, init) => { requestSignal = init?.signal as AbortSignal; return new Promise<Response>((_resolve, reject) => { requestSignal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }); }); });
    const controller = new AbortController(); const pending = collect(provider.generate(request, context(controller.signal))); await new Promise((resolve) => setTimeout(resolve, 0)); controller.abort();
    await expect(pending).rejects.toMatchObject({ error: { code: "CANCELLED" } });
    expect(requestSignal?.aborted).toBe(true);
  });
  it("distinguishes deadline timeout", async () => {
    let aborted = false;
    const provider = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model" }, async (_input, init) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("timeout", "AbortError")); }, { once: true }); }));
    await expect(collect(provider.generate(request, context(new AbortController().signal, Date.now() + 5)))).rejects.toMatchObject({ error: { code: "TIMEOUT" } });
    expect(aborted).toBe(true);
  });
  it("checks model availability by id or alias without generation", async () => {
    const provider = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model" }, async (input) => { expect(String(input)).toContain("/v1/models"); return response(null, 200, { data: [{ id: "other-model", aliases: ["local-model"] }] }); });
    expect(await provider.health()).toEqual({ status: "healthy" });
    expect(createOpenAICompatiblePlugin(provider).manifest.provides.map((item) => item.id)).toEqual(["model.text", "model.streaming", "model.tools"]);
  });
  it("reports health diagnostics", async () => {
    const unreachable = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model" }, async () => { throw new Error("connection refused"); });
    expect(await unreachable.health()).toMatchObject({ status: "unhealthy", reason: "unreachable" });
    const missing = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "missing-model" }, async () => response(null, 200, { data: [{ id: "other-model" }] }));
    expect(await missing.health()).toMatchObject({ status: "unhealthy", reason: "resource-unavailable", details: { resourceType: "model", resourceName: "missing-model" } });
    const malformed = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model" }, async () => response(null, 200, { invalid: true }));
    expect(await malformed.health()).toMatchObject({ status: "unhealthy", reason: "invalid-response" });
  });
  it("reports health request timeouts", async () => {
    const provider = new OpenAICompatibleModelProvider({ baseUrl: "http://provider.test", model: "local-model", timeoutMs: 1 }, async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true })));
    expect(await provider.health()).toMatchObject({ status: "unhealthy", reason: "timeout" });
  });
});

const live = process.env.RUN_OPENAI_COMPATIBLE_INTEGRATION_TESTS === "1" ? describe : describe.skip;
live("OpenAI-compatible live smoke", () => {
  it("streams text and tool calls from a configured server", async () => {
    const provider = new OpenAICompatibleModelProvider({ baseUrl: process.env.PORTA_MODEL_BASE_URL ?? "http://127.0.0.1:8080", model: process.env.PORTA_MODEL ?? "" });
    expect((await provider.health()).status).toBe("healthy");
    const events = await collect(provider.generate({ ...request, input: "Reply with exactly: pong", tools }, context()));
    expect(events.some((event) => event.type === "delta")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "completed" });
    const toolEvents = await collect(provider.generate({ ...request, input: "Use the echo tool with value ok.", tools }, context()));
    expect(toolCall(toolEvents)?.toolId).toBe("server-a/echo");
  }, 300_000);
});
