import { describe, expect, it } from "vitest";
import { MockModelProvider } from "../src/adapters.js";
import { InteractiveApprovalGateway } from "../src/application-gateway.js";
import { createPortaApplication } from "../src/porta-application.js";
import { parsePortaConfig } from "../src/porta-config.js";

const config = () => parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://localhost:11434", model: "test-model" }, tools: [] });

describe("Porta application composition", () => {
  it("rejects missing model configuration", () => expect(() => parsePortaConfig({ model: { provider: "ollama", baseUrl: "not-url" } })).toThrow());
  it("registers configured filesystem and scratchpad tools", async () => {
    const app = await createPortaApplication({ ...config(), filesystem: { root: "." } }, { model: () => new MockModelProvider("ready") });
    expect(app.toolRouter.listTools().map((tool) => tool.canonicalId)).toEqual(expect.arrayContaining(["filesystem/read_file", "filesystem/list_directory", "filesystem/stat", "filesystem/search", "scratchpad/read", "scratchpad/write", "scratchpad/search"])); expect(app.searchEngines.filesystem).toBeTruthy(); expect(app.searchEngines.scratchpad).toBe("linear");
    await app.shutdown();
  });
  it("exposes mutation tools only when explicitly enabled", async () => {
    const app = await createPortaApplication({ ...config(), filesystem: { root: ".", mutation: { enabled: true } } }, { model: () => new MockModelProvider("ready") });
    expect(app.toolRouter.listTools().map((tool) => tool.canonicalId)).toEqual(expect.arrayContaining(["filesystem/write_file", "filesystem/patch_file"])); await app.shutdown();
  });
  it("registers execution only when explicitly enabled", async () => {
    const root = process.cwd(); const disabled = await createPortaApplication(parsePortaConfig({ ...config(), filesystem: { root }, execution: { enabled: false } }), { model: () => new MockModelProvider("ready") }); expect(disabled.toolRouter.listTools().some((tool) => tool.canonicalId === "execution/run")).toBe(false); await disabled.shutdown();
    const enabled = await createPortaApplication(parsePortaConfig({ ...config(), filesystem: { root }, execution: { enabled: true, allowedCommands: ["node"] } }), { model: () => new MockModelProvider("ready") }); expect(enabled.toolRouter.listTools().some((tool) => tool.canonicalId === "execution/run")).toBe(true); await enabled.shutdown();
  });
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
