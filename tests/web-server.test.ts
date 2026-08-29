import { describe, expect, it } from "vitest";
import { ApplicationGateway, KernelCommand } from "../src/contracts.js";
import { createPortaWebServer } from "../src/web-server.js";

describe("Porta web server", () => {
  it("serves the UI and streams gateway events", async () => {
    const gateway: ApplicationGateway = {
      async *execute(command: KernelCommand) {
        if (command.type === "CreateSession") yield { type: "SessionCreated", sessionId: "web-session" };
        if (command.type === "SubmitInput") {
          yield { type: "OutputStarted" };
          yield { type: "OutputDelta", text: "hello" };
          yield { type: "ExecutionCompleted" };
        }
      },
    };
    const server = createPortaWebServer({ gateway }, { port: 0 });
    await server.listen();
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");
    try {
      const page = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Porta");

      const session = await fetch(`http://127.0.0.1:${address.port}/api/sessions`, { method: "POST", body: "{}" });
      expect(await session.json()).toEqual({ type: "SessionCreated", sessionId: "web-session" });

      const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/web-session/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "hi" }) });
      expect(await response.text()).toContain('"type":"OutputDelta"');
    } finally {
      await server.close();
    }
  });
});
