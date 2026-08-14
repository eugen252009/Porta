import { describe, expect, it } from "vitest";
import { MockModelProvider } from "../src/adapters.js";
import { InteractiveApprovalGateway } from "../src/application-gateway.js";
import { createPortaApplication } from "../src/porta-application.js";
import { parsePortaConfig } from "../src/porta-config.js";

const config = () => parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://localhost:11434", model: "test-model" }, tools: [] });

describe("Porta application composition", () => {
  it("rejects missing model configuration", () => expect(() => parsePortaConfig({ model: { provider: "ollama", baseUrl: "not-url" } })).toThrow());
  it("composes a healthy text-only application without contacting Ollama", async () => {
    const app = await createPortaApplication(config(), { model: () => new MockModelProvider("ready") });
    await app.start();
    const created = [...(await collect(app.gateway, { type: "CreateSession" }))];
    const sessionId = created.find((event) => event.type === "SessionCreated")!.sessionId;
    const events = await collect(app.gateway, { type: "SubmitInput", sessionId, input: "hello" });
    expect(events.some((event) => event.type === "OutputDelta" && event.text === "ready")).toBe(true);
    await app.shutdown(); await app.shutdown();
    expect(app.pendingApprovals.pendingCount).toBe(0);
  });
});

async function collect(gateway: InteractiveApprovalGateway, command: Parameters<InteractiveApprovalGateway["execute"]>[0]) {
  const events = []; for await (const event of gateway.execute(command, {})) events.push(event); return events;
}
