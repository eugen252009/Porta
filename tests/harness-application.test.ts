import { describe, expect, it } from "vitest";
import { MockModelProvider } from "../src/adapters.js";
import { InteractiveApprovalGateway } from "../src/application-gateway.js";
import { createHarnessApplication } from "../src/harness-application.js";
import { parseHarnessConfig } from "../src/harness-config.js";

const config = () => parseHarnessConfig({ model: { provider: "ollama", baseUrl: "http://localhost:11434", model: "test-model" }, tools: [] });

describe("production harness composition", () => {
  it("rejects missing model configuration", () => expect(() => parseHarnessConfig({ model: { provider: "ollama", baseUrl: "not-url" } })).toThrow());
  it("composes a healthy text-only application without contacting Ollama", async () => {
    const app = await createHarnessApplication(config(), { model: () => new MockModelProvider("ready") });
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
