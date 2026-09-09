import { describe, expect, it } from "vitest";
import { ApplicationGateway, KernelCommand } from "../src/contracts.js";
import { createPortaWebServer } from "../src/web-server.js";

describe("Porta web server", () => {
  it("serves the UI and streams gateway events", async () => {
    let selectedModel: unknown;
    const gateway: ApplicationGateway = {
      async *execute(command: KernelCommand) {
        if (command.type === "CreateSession" && command.model) selectedModel = command.model;
        if (command.type === "CreateSession") yield { type: "SessionCreated", sessionId: "web-session" };
        if (command.type === "SubmitInput") {
          yield { type: "OutputStarted" };
          yield { type: "OutputDelta", text: "hello" };
          yield { type: "ExecutionCompleted" };
        }
      },
    };
    const server = createPortaWebServer({ gateway, modelSelection: { provider: "ollama", model: "initial" }, modelCatalog: async () => [{ provider: "ollama", id: "initial", displayName: "Initial" }, { provider: "ollama", id: "next", displayName: "Next" }], modelCatalogStatus: async () => ({ provider: "ollama", status: "available" as const, models: [{ provider: "ollama", id: "initial", displayName: "Initial" }, { provider: "ollama", id: "next", displayName: "Next" }] }), uiSessions: new Map([["test-ui", Date.now() + 60_000]]) }, { port: 0 });
    await server.listen();
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");
    try {
      const unauthorized = await fetch(`http://127.0.0.1:${address.port}/api/models`);
      expect(unauthorized.status).toBe(401);
      const version = await fetch(`http://127.0.0.1:${address.port}/version`);
      expect(version.status).toBe(200);
      expect(version.headers.get("content-type")).toContain("application/json");
      expect(await version.json()).toMatchObject({ version: "0.1.0", commit: "unknown", buildId: "development", dirty: null });
      const uiCookie = "porta_ui=test-ui";
      const blockedApp = await fetch(`http://127.0.0.1:${address.port}/app`, { redirect: "manual" });
      expect(blockedApp.status).toBe(303);
      const appPage = await fetch(`http://127.0.0.1:${address.port}/app`, { headers: { cookie: uiCookie } });
      expect(appPage.status).toBe(200);
      expect(appPage.headers.get("content-type")).toContain("text/html");
      expect(await appPage.text()).toContain('id="composer"');
      const appAsset = await fetch(`http://127.0.0.1:${address.port}/app.js`);
      expect(appAsset.status).toBe(200);
      const page = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Porta");

      const models = await fetch(`http://127.0.0.1:${address.port}/api/models`, { headers: { cookie: uiCookie } });
      expect(await models.json()).toEqual({ provider: "ollama", status: "available", current: { provider: "ollama", model: "initial" }, models: [{ provider: "ollama", id: "initial", displayName: "Initial" }, { provider: "ollama", id: "next", displayName: "Next" }] });
      const session = await fetch(`http://127.0.0.1:${address.port}/api/sessions`, { method: "POST", headers: { "content-type": "application/json", cookie: uiCookie }, body: JSON.stringify({ model: { provider: "ollama", model: "next" } }) });
      expect(await session.json()).toEqual({ type: "SessionCreated", sessionId: "web-session" });
      expect(selectedModel).toEqual({ provider: "ollama", model: "next" });

      const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/web-session/messages`, { method: "POST", headers: { "content-type": "application/json", cookie: uiCookie }, body: JSON.stringify({ input: "hi" }) });
      expect(await response.text()).toContain('"type":"OutputDelta"');
    } finally {
      await server.close();
    }
  });
});
