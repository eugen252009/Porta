import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../src/provider-registry.js";
import { parsePortaConfig } from "../src/porta-config.js";

describe("provider registry", () => {
  it("tests and persists target-owned Ollama providers without secrets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "qwen" }] }), { status: 200 })));
    const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://localhost:11434", model: "qwen" } });
    const registry = new ProviderRegistry(config, "/tmp/porta-provider-test.json");
    await expect(registry.create({ id: "nas-ollama", type: "ollama", name: "NAS Ollama", endpoint: "http://192.168.188.2:11434" })).resolves.toBeUndefined();
    expect((await registry.describe())[0]).toMatchObject({ id: "nas-ollama", modelCount: 1, credentialConfigured: false });
    expect(JSON.stringify(await registry.describe())).not.toMatch(/token|secret|apiKey/i);
    vi.unstubAllGlobals();
  });
  it("supports unauthenticated OpenAI-compatible model servers", async () => {
    const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://localhost:11434", model: "qwen" } });
    const requests: Request[] = []; vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { requests.push(new Request(url, init)); return new Response(JSON.stringify({ data: [{ id: "gguf-model" }] }), { status: 200 }); }));
    const registry = new ProviderRegistry(config, "/tmp/porta-provider-openai.json");
    await registry.create({ id: "llama-server", type: "openai-compatible", name: "llama.cpp", endpoint: "http://workstation:8080/v1" });
    expect((await registry.describe())[0]).toMatchObject({ type: "openai-compatible", modelCount: 1, credentialConfigured: false });
    expect(requests[0]?.url).toBe("http://workstation:8080/v1/models");
    expect(requests[0]?.headers.has("authorization")).toBe(false);
    vi.unstubAllGlobals();
  });
  it("rejects duplicate provider IDs", async () => {
    const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://localhost:11434", model: "qwen" } });
    const registry = new ProviderRegistry(config, "/tmp/porta-provider-test-duplicate.json");
    const provider = { id: "same", type: "ollama" as const, name: "Same", endpoint: "http://localhost:11434" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "qwen" }] }), { status: 200 })));
    await registry.create(provider);
    await expect(registry.create(provider)).rejects.toThrow("already exists");
    vi.unstubAllGlobals();
  });
});
