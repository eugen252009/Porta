import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPortaConfig, parsePortaConfig } from "../src/porta-config.js";
import { createPortaApplication } from "../src/porta-application.js";
import { CodexCredentialStore } from "../src/adapters/codex-auth.js";

const roots: string[] = [];
async function root() { const directory = await mkdtemp(join(tmpdir(), "porta-codex-config-")); roots.push(directory); return directory; }
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("Codex configuration and composition", () => {
  it("selects subscription auth without a base URL or API key and keeps existing provider defaults", () => {
    expect(parsePortaConfig({ model: { provider: "openai-codex", model: "test" } }).model).toEqual({ provider: "openai-codex", model: "test", timeoutMs: 120000, maxResponseBytes: 8388608 });
    expect(parsePortaConfig({ model: { baseUrl: "http://localhost:11434", model: "test" } }).model.provider).toBe("ollama");
    for (const extra of [{ baseUrl: "https://untrusted.test" }, { apiKey: "secret" }, { model: "" }, { provider: "unknown" }, { maxResponseBytes: -1 }]) {
      expect(() => parsePortaConfig({ model: { provider: "openai-codex", model: "test", ...extra } })).toThrow();
    }
  });

  it("loads Codex from environment or JSON and does not forward unrelated endpoint/key variables", async () => {
    vi.stubEnv("PORTA_CONFIG", ""); vi.stubEnv("HARNESS_CONFIG", "");
    vi.stubEnv("PORTA_MODEL_PROVIDER", "openai-codex"); vi.stubEnv("PORTA_MODEL", "env-model");
    vi.stubEnv("PORTA_MODEL_BASE_URL", "https://untrusted.test"); vi.stubEnv("OPENAI_API_KEY", "api-billing-key");
    expect((await loadPortaConfig()).model).toMatchObject({ provider: "openai-codex", model: "env-model" });
    expect((await loadPortaConfig()).model).not.toHaveProperty("baseUrl");
    const file = join(await root(), "config.json");
    await writeFile(file, JSON.stringify({ model: { provider: "openai-codex", model: "file-model", timeoutMs: 5000 } }));
    expect((await loadPortaConfig(file)).model).toMatchObject({ model: "file-model", timeoutMs: 5000 });
    await writeFile(file, JSON.stringify({ model: { provider: "openai-codex", model: "file-model", baseUrl: "https://untrusted.test" } }));
    await expect(loadPortaConfig(file)).rejects.toThrow();
    vi.stubEnv("PORTA_MODEL_PROVIDER", "typo"); await expect(loadPortaConfig("")).rejects.toThrow();
  });

  it("uses the Codex adapter through normal composition, with canonical tool authorization and history replay", async () => {
    const directory = join(await root(), "auth"); vi.stubEnv("PORTA_AUTH_DIR", directory);
    await new CodexCredentialStore().modify(new AbortController().signal, async () => ({ type: "oauth", access: "subscription-token", refresh: "refresh", expires: Date.now() + 3600000, accountId: "account" }));
    const bodies: { tools: { name: string; description: string }[]; input: unknown[] }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as typeof bodies[number]; bodies.push(body);
      if (bodies.length === 1) {
        const tool = body.tools.find((entry) => entry.description.toLowerCase().includes("scratchpad"))!;
        expect(tool).toBeDefined();
        const call = { type: "function_call", call_id: "call", name: tool.name, arguments: "{}" };
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [call] } })}\n\n`);
      }
      return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ready" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`);
    }));
    const app = await createPortaApplication(parsePortaConfig({ model: { provider: "openai-codex", model: "test" }, authorization: { mode: "require-approval" } }));
    try {
      let sessionId = "";
      for await (const event of app.gateway.execute({ type: "CreateSession" })) if (event.type === "SessionCreated") sessionId = event.sessionId;
      const events = [];
      for await (const event of app.gateway.execute({ type: "SubmitInput", sessionId, input: "hello" })) {
        events.push(event);
        if (event.type === "ApprovalRequested") app.pendingApprovals.resolve(event.approvalId, { decision: "deny" });
      }
      expect(events).toContainEqual(expect.objectContaining({ type: "OutputDelta", text: "ready" }));
      expect(events).toContainEqual(expect.objectContaining({ type: "ToolRequested", toolId: expect.stringContaining("scratchpad/") }));
      expect(JSON.stringify(bodies[1]?.input)).toContain("AUTHORIZATION_DENIED");
      expect(JSON.stringify(bodies)).not.toContain("subscription-token");
    } finally { await app.shutdown(); }
  });
});
