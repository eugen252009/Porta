import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync("integrations/chatgpt-browser-extension/background.js", "utf8");
function fixture() {
  const requests: { idempotencyKey: string; sessionId?: string }[] = [];
  const stored = { endpoint: "http://localhost:4174", token: "fixture-only", sessionMappings: {} };
  const context = {
    URL, TextEncoder, Uint8Array, crypto: webcrypto,
    chrome: { runtime: { onMessage: { addListener() {} } }, storage: { local: { async get() { return stored; }, async set(value: object) { Object.assign(stored, value); } } } },
    fetch: async (_url: unknown, options: { body: string }) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ sessionId: "session-1", jobId: "job-1", durable: true, status: "accepted" }) }; },
  };
  runInNewContext(source, context);
  return { requests, submit: (overrides: object = {}) => runInNewContext(`submit(${JSON.stringify({ type: "porta.submitPrompt", nodeId: "local", conversationId: "conversation", content: "Build a fixture", idempotencyKey: "first-click", ...overrides })})`, context) };
}

describe("extension durable handoff", () => {
  it("uses the same receipt key after a page reload and returns a status link", async () => {
    const client = fixture(); await client.submit(); const result = await client.submit({ idempotencyKey: "new-page-click" });
    expect(client.requests[0]?.idempotencyKey).toBe(client.requests[1]?.idempotencyKey);
    expect(client.requests[1]?.sessionId).toBe("session-1");
    expect(result.statusUrl).toBe("http://localhost:4174/app?session=session-1");
  });
  it("allows an explicit new session and rejects malformed input before sending", async () => {
    const client = fixture(); await client.submit({ newSession: true, idempotencyKey: "fresh" });
    expect(client.requests[0]?.idempotencyKey).toBe("fresh"); expect(client.requests[0]?.sessionId).toBeUndefined();
    await expect(client.submit({ content: " " })).rejects.toThrow("INVALID_PROMPT");
    await expect(client.submit({ idempotencyKey: "bad key" })).rejects.toThrow("INVALID_IDEMPOTENCY_KEY");
    expect(client.requests).toHaveLength(1);
  });
});
