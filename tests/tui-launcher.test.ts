import { describe, expect, it, vi } from "vitest";
import { createTuiSession, runTui } from "../src/tui-launcher.js";
import { ApplicationGateway, KernelEvent } from "../src/contracts.js";
import { PortaConfig } from "../src/porta-config.js";

function gateway(events: KernelEvent[]): ApplicationGateway {
  return { execute: vi.fn(async function* () { yield* events; }) };
}

const config = {
  model: { provider: "ollama", baseUrl: "http://localhost:11434", model: "test-model" },
  tools: [],
  authorization: { mode: "require-approval" },
  agent: {},
  conversation: {},
} satisfies PortaConfig;

describe("TUI launcher", () => {
  it("creates a fresh session and waits for Ink to exit", async () => {
    const app = { gateway: gateway([{ type: "SessionCreated", sessionId: "session-1" }]) };
    const waitUntilExit = vi.fn(async () => undefined);
    const render = vi.fn(() => ({ waitUntilExit }));

    await expect(runTui(app, config, render)).resolves.toBe("session-1");
    expect(render).toHaveBeenCalledOnce();
    expect(waitUntilExit).toHaveBeenCalledOnce();
  });

  it("passes a requested session ID through for resume", async () => {
    const app = { gateway: gateway([{ type: "SessionCreated", sessionId: "existing" }]) };
    const render = vi.fn(() => ({ waitUntilExit: async () => undefined }));

    await runTui(app, config, render, "existing");
    expect(app.gateway.execute).toHaveBeenCalledWith({ type: "CreateSession", sessionId: "existing" }, {});
  });

  it("surfaces gateway startup errors", async () => {
    const app = { gateway: gateway([{ type: "Error", error: { code: "STORAGE_FAILED", message: "unavailable", retryable: false } }]) };
    const render = vi.fn(() => ({ waitUntilExit: async () => undefined }));

    await expect(createTuiSession(app.gateway)).rejects.toMatchObject({ error: { message: "unavailable" } });
    expect(render).not.toHaveBeenCalled();
  });
});
