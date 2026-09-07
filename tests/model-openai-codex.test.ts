import { describe, expect, it, vi } from "vitest";
import { OpenAICodexModelProvider, createOpenAICodexPlugin, mapRequestToCodex } from "../src/adapters/model-openai-codex.js";
import { type ModelContext, type ModelEvent, type ModelRequest, type ToolDescriptor } from "../src/contracts.js";
import { planPlugins } from "../src/plugin-preflight.js";

const request: ModelRequest = { schemaVersion: 1, requestId: "request", input: "hello" };
const context = (signal = new AbortController().signal): ModelContext => ({ signal, traceId: "trace", sessionId: "session", executionId: "execution" });
const tools: ToolDescriptor[] = [{ id: "server-a/echo", name: "echo", version: "1", inputSchema: { type: "object", properties: { value: { type: "string" } } } }, { id: "server-b/echo", name: "echo", version: "1", inputSchema: { type: "object" } }];
const auth = { getAccess: vi.fn(async () => ({ access: "private-access-token", accountId: "account" })) };
const call = { type: "function_call", call_id: "native-call", name: "harness_tool_1", arguments: '{"value":"ok"}' };
const done = (output: unknown[] = []) => ({ type: "response.completed", response: { status: "completed", output } });
const sse = (...values: unknown[]) => values.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join("");
const text = (delta = "hello") => ({ type: "response.output_text.delta", delta });
const response = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
async function collect(iterable: AsyncIterable<ModelEvent>) { const events: ModelEvent[] = []; for await (const event of iterable) events.push(event); return events; }
const provider = (body: string, config = {}) => new OpenAICodexModelProvider({ model: "gpt-5.3-codex", ...config }, auth, async () => response(body));

describe("Codex subscription adapter", () => {
  it("validates configuration and plans capabilities without auth or network", () => {
    expect(() => provider("", { model: "" })).toThrow();
    expect(() => provider("", { timeoutMs: -1 })).toThrow();
    expect(() => provider("", { maxResponseBytes: 0 })).toThrow();
    const getAccess = vi.fn(); const fetch = vi.fn();
    const model = new OpenAICodexModelProvider({ model: "test" }, { getAccess }, fetch);
    expect(planPlugins([createOpenAICodexPlugin(model).manifest]).status).toBe("ready");
    expect(model.descriptor.capabilities.map((item) => item.id)).toContain("model.tools");
    expect(getAccess).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("maps canonical controls, history, tool results and colliding display names", () => {
    const mapped = mapRequestToCodex({ ...request, tools, control: [{ role: "system", content: "one" }, { role: "system", content: "two" }], messages: [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "checking", toolCalls: [{ id: "arbitrary/id|native", toolId: "server-b/echo", input: { value: "ok" } }] },
      { role: "tool", toolCallId: "arbitrary/id|native", toolId: "server-b/echo", result: { toolCallId: "arbitrary/id|native", toolId: "server-b/echo", output: null, error: { code: "AUTHORIZATION_DENIED", message: "denied", retryable: false } } },
    ] }, "test") as { input: { call_id?: string }[] };
    expect(mapped).toMatchObject({ store: false, stream: true, instructions: "one\n\ntwo", tools: [{ name: "harness_tool_0" }, { name: "harness_tool_1" }], input: [{ role: "user", content: "earlier" }, { role: "assistant" }, { type: "function_call", name: "harness_tool_1" }, { type: "function_call_output", output: expect.stringContaining("AUTHORIZATION_DENIED") }] });
    expect(mapped.input[2]?.call_id).toBe(mapped.input[3]?.call_id);
    expect(mapped.input[2]?.call_id).toMatch(/^call_[a-f0-9]+$/);
    expect(JSON.stringify(mapped)).not.toContain('"content":"hello"');
    expect(mapRequestToCodex({ ...request, messages: [] }, "test")).toMatchObject({ input: [{ role: "user", content: "hello" }] });
  });

  it("sends OAuth to the fixed Codex endpoint, without redirects or API billing fallback", async () => {
    const fetch = vi.fn(async () => response(sse(text(), done())));
    const model = new OpenAICodexModelProvider({ model: "test" }, auth, fetch);
    expect(await collect(model.generate(request, context()))).toEqual([{ type: "delta", text: "hello" }, { type: "completed" }]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("https://chatgpt.com/backend-api/codex/responses", expect.objectContaining({ redirect: "error", method: "POST", headers: expect.objectContaining({ authorization: "Bearer private-access-token", "chatgpt-account-id": "account", "OpenAI-Beta": "responses=experimental" }) }));
  });

  it("handles fragmented UTF-8, CRLF, comments, and multiline SSE data", async () => {
    const raw = new TextEncoder().encode(': keepalive\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"hé🙂"}\r\n\r\n' + sse(done()));
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of raw) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
    const model = new OpenAICodexModelProvider({ model: "test" }, auth, async () => new Response(stream));
    expect(await collect(model.generate(request, context()))).toEqual([{ type: "delta", text: "hé🙂" }, { type: "completed" }]);
  });

  it("strictly parses authoritative tool arguments and creates unique canonical call IDs", async () => {
    const model = provider(sse({ type: "response.reasoning_summary_text.delta", delta: "private reasoning" }, { type: "response.function_call_arguments.delta", delta: '{"value":' }, { type: "response.output_item.done", item: call }, done([call])));
    const first = await collect(model.generate({ ...request, tools }, context()));
    const second = await collect(model.generate({ ...request, tools }, context()));
    expect(first).toEqual([{ type: "tool-call", call: { id: expect.stringMatching(/^codex-tool-/), toolId: "server-b/echo", input: { value: "ok" } } }, { type: "completed" }]);
    expect(first[0]).not.toEqual(second[0]);
  });

  it("retains completed streamed calls when real Codex finishes with an empty output summary", async () => {
    const raw = sse(
      { type: "response.output_item.added", item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"value":' },
      { type: "response.function_call_arguments.done", arguments: call.arguments },
      { type: "response.output_item.done", item: call },
      done([]),
    );
    expect(await collect(provider(raw).generate({ ...request, tools }, context()))).toEqual([
      { type: "tool-call", call: { id: expect.stringMatching(/^codex-tool-/), toolId: "server-b/echo", input: { value: "ok" } } },
      { type: "completed" },
    ]);
  });

  it("accepts final-only tool calls and final SSE events without a newline", async () => {
    const events = await collect(provider(`data: ${JSON.stringify(done([call]))}`).generate({ ...request, tools }, context()));
    expect(events[0]).toMatchObject({ type: "tool-call", call: { toolId: "server-b/echo" } });
  });

  it.each([
    ["truncated stream", sse(text())], ["bare DONE", "data: [DONE]\n\n"], ["bad JSON", "data: {not-json}\n\n"],
    ["bad delta", sse({ type: "response.output_text.delta", delta: 4 }, done())],
    ["bad event", sse({ what: "event" })], ["provider error", sse({ type: "error", message: "private-access-token" })],
    ["incomplete", sse({ type: "response.incomplete" })], ["failed", sse({ type: "response.failed" })],
    ["bad completion", sse({ type: "response.completed", response: { status: "incomplete", output: [] } })],
    ["unknown tool", sse(done([{ ...call, name: "echo" }]))],
    ["malformed arguments", sse(done([{ ...call, arguments: '{"value":' }]))],
    ["non-finite arguments", sse(done([{ ...call, arguments: '{"value":1e999}' }]))],
    ["partial nonempty final manifest", sse({ type: "response.output_item.done", item: call }, { type: "response.output_item.done", item: { ...call, call_id: "second" } }, done([call]))],
    ["unfinished call with empty summary", sse({ type: "response.output_item.added", item: { ...call, arguments: "" } }, { type: "response.function_call_arguments.done", arguments: call.arguments }, done([]))],
    ["unfinished second call after a completed call", sse({ type: "response.output_item.done", item: call }, { type: "response.output_item.added", item: { ...call, call_id: "second", arguments: "" } }, done([]))],
    ["truncated call stream", sse({ type: "response.output_item.done", item: call })],
    ["failed call stream", sse({ type: "response.output_item.done", item: call }, { type: "response.failed" })],
    ["changed final call", sse({ type: "response.output_item.done", item: call }, done([{ ...call, arguments: "{}" }]))],
    ["duplicate final call", sse(done([call, call]))],
  ])("fails closed on %s without executing tools or exposing provider errors", async (_name, raw) => {
    const events: ModelEvent[] = [];
    await expect((async () => { for await (const event of provider(raw).generate({ ...request, tools }, context())) events.push(event); })()).rejects.toMatchObject({ error: { code: "MODEL_FAILED", message: expect.not.stringContaining("private-access-token") } });
    expect(events.some((event) => event.type !== "delta")).toBe(false);
  });

  it.each([401, 403, 429, 500, 400])("normalizes HTTP %s without reading or leaking its body", async (status) => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const model = new OpenAICodexModelProvider({ model: "test" }, auth, async () => new Response(stream, { status }));
    await expect(collect(model.generate(request, context()))).rejects.toMatchObject({ error: { code: status === 401 || status === 403 ? "AUTHORIZATION_DENIED" : "MODEL_FAILED", retryable: status === 429 || status >= 500 } });
    expect(cancelled).toBe(true);
  });

  it("rejects missing credentials before contacting the backend", async () => {
    const fetch = vi.fn();
    const model = new OpenAICodexModelProvider({ model: "test" }, { getAccess: async () => { throw new Error("private-access-token"); } }, fetch);
    await expect(collect(model.generate(request, context()))).rejects.toMatchObject({ error: { message: expect.not.stringContaining("private-access-token") } });
    expect(fetch).not.toHaveBeenCalled();
    expect(await model.health()).toMatchObject({ status: "unhealthy", reason: "configuration-invalid" });
  });

  it("reports credential readiness without generating or checking models over the network", async () => {
    const fetch = vi.fn(); const model = new OpenAICodexModelProvider({ model: "test" }, auth, fetch);
    expect(await model.health()).toMatchObject({ status: "healthy", message: expect.stringContaining("checked on generation") });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces response, request and tool-call limits", async () => {
    await expect(collect(provider(sse(text("a".repeat(200)), done()), { maxResponseBytes: 100 }).generate(request, context()))).rejects.toMatchObject({ error: { code: "MODEL_FAILED", message: expect.stringContaining("byte limit") } });
    const fetch = vi.fn();
    await expect(collect(new OpenAICodexModelProvider({ model: "test" }, auth, fetch).generate({ ...request, input: "x".repeat(4 * 1024 * 1024) }, context()))).rejects.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(fetch).not.toHaveBeenCalled();
    await expect(collect(provider(sse(done(Array.from({ length: 129 }, (_, i) => ({ ...call, call_id: `call-${i}` }))))).generate({ ...request, tools }, context()))).rejects.toMatchObject({ error: { message: expect.stringContaining("128 tool-call") } });
  });

  it("does no auth or network work when already cancelled or past deadline", async () => {
    const getAccess = vi.fn(); const fetch = vi.fn(); const control = new AbortController(); control.abort();
    const model = new OpenAICodexModelProvider({ model: "test" }, { getAccess }, fetch);
    await expect(collect(model.generate(request, context(control.signal)))).rejects.toMatchObject({ error: { code: "CANCELLED" } });
    await expect(collect(model.generate(request, { ...context(), deadline: Date.now() - 1 }))).rejects.toMatchObject({ error: { code: "TIMEOUT" } });
    expect(getAccess).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["auth", "headers"])("times out while waiting for %s and passes the abort signal through", async (stage) => {
    const wait = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private transport details")), { once: true });
    });
    const model = new OpenAICodexModelProvider({ model: "test", timeoutMs: 20 }, stage === "auth" ? { getAccess: wait } : auth,
      async (_url, init) => wait(init!.signal!));
    await expect(collect(model.generate(request, context()))).rejects.toMatchObject({ error: { code: "TIMEOUT" } });
  });

  it.each(["cancel", "timeout", "deadline"])("interrupts a stalled body on %s and releases it", async (mode) => {
    const control = new AbortController(); let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(sse(text()))); }, cancel() { cancelled = true; } });
    const model = new OpenAICodexModelProvider({ model: "test", timeoutMs: mode === "timeout" ? 20 : 1000 }, auth, async () => new Response(body));
    const iterator = model.generate(request, { ...context(control.signal), ...(mode === "deadline" ? { deadline: Date.now() + 20 } : {}) })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "delta" });
    const pending = iterator.next(); if (mode === "cancel") control.abort();
    await expect(pending).rejects.toMatchObject({ error: { code: mode === "cancel" ? "CANCELLED" : "TIMEOUT" } });
    expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  });

  it("aborts the request and cancels its reader when the consumer stops early", async () => {
    let signal: AbortSignal | null | undefined; let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(sse(text()))); }, cancel() { cancelled = true; } });
    const model = new OpenAICodexModelProvider({ model: "test" }, auth, async (_url, init) => { signal = init?.signal; return new Response(stream); });
    for await (const _event of model.generate(request, context())) break;
    expect(cancelled).toBe(true); expect(signal?.aborted).toBe(true);
  });
});
