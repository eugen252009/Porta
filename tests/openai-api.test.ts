import { describe, expect, it } from "vitest";
import { createPortaWebServer } from "../src/web-server.js";
import type { ModelContext, ModelEvent, ModelProvider } from "../src/contracts.js";

class FixtureProvider implements ModelProvider {
  readonly descriptor = { id: "fixture", version: "1", capabilities: [] };
  readonly requests: ModelContext[] = [];
  constructor(private readonly delayMs = 0) {}
  async *generate(_request: Parameters<ModelProvider["generate"]>[0], context: ModelContext): AsyncIterable<ModelEvent> {
    this.requests.push(context);
    yield { type: "delta", text: "hello" };
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (context.signal.aborted) return;
    yield { type: "delta", text: " world" };
    yield { type: "completed" };
  }
}

async function setup(provider = new FixtureProvider(), apiOnly = true) {
  const server = createPortaWebServer({
    modelCatalog: async () => [{ provider: "ollama", id: "fixture", displayName: "Fixture" }, { provider: "codex", id: "gpt-test", displayName: "GPT Test" }],
    resolveModel: async () => provider,
    gateway: { async *execute() {} },
  }, { port: 0, apiOnly });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const requestBody = (model = "ollama/fixture", stream = false) => ({ model, messages: [{ role: "system", content: "Be concise." }, { role: "user", content: "Hi" }], stream, temperature: 0 });

describe("OpenAI-compatible API", () => {
  it("keeps the machine API off the UI listener and serves it on an API-only listener", async () => {
    const provider = new FixtureProvider();
    const ui = await setup(provider, false);
    const api = createPortaWebServer({ modelCatalog: async () => [{ provider: "ollama", id: "fixture", displayName: "Fixture" }], resolveModel: async () => provider, gateway: { async *execute() {} } }, { port: 0, apiOnly: true });
    await api.listen();
    const address = api.server.address();
    if (!address || typeof address === "string") throw new Error("API address unavailable");
    try {
      expect((await fetch(`${ui.url}/v1/models`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${address.port}/v1/models`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${address.port}/`)).status).toBe(404);
    } finally { await api.close(); await ui.server.close(); }
  });
  it("lists provider-qualified models", async () => {
    const { server, url } = await setup();
    try {
      const response = await fetch(`${url}/v1/models`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ object: "list", data: [{ id: "ollama/fixture", object: "model" }, { id: "codex/gpt-test", object: "model" }] });
    } finally { await server.close(); }
  });

  it("returns a non-streaming chat completion", async () => {
    const provider = new FixtureProvider(); const { server, url } = await setup(provider);
    try {
      const response = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody()) });
      const value = await response.json();
      expect(response.status).toBe(200);
      expect(value).toMatchObject({ object: "chat.completion", model: "ollama/fixture", choices: [{ message: { role: "assistant", content: "hello world" }, finish_reason: "stop" }] });
    } finally { await server.close(); }
  });

  it("returns incrementally framed OpenAI SSE and DONE", async () => {
    const { server, url } = await setup(new FixtureProvider(40));
    try {
      const response = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody("ollama/fixture", true)) });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const text = await response.text();
      expect(text).toContain("data: {");
      expect(text).toContain('"content":"hello"');
      expect(text).toContain('"content":" world"');
      expect(text).toContain("data: [DONE]\n\n");
      expect(text).not.toContain("{\"type\":\"delta\"");
    } finally { await server.close(); }
  });

  it("rejects malformed and unqualified model requests", async () => {
    const { server, url } = await setup();
    try {
      const malformed = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
      expect(malformed.status).toBe(400);
      expect((await malformed.json()).error.code).toBe("invalid_json");
      const unknown = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody("ollama/missing")) });
      expect(unknown.status).toBe(404);
      expect((await unknown.json()).error.code).toBe("model_not_found");
    } finally { await server.close(); }
  });
});
