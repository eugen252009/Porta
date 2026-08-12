import { describe, expect, it } from "vitest";
import { MockToolProvider } from "../src/tool-mocks.js";
import { ToolRouter } from "../src/tools.js";
import { ToolContext, ToolProvider } from "../src/index.js";

const context = (signal = new AbortController().signal, deadline?: number): ToolContext => ({ traceId: "trace", sessionId: "session", executionId: "invocation", signal, deadline });
const collectContext = () => context();

describe("ToolProvider foundation", () => {
  it("discovers deterministic descriptors and keeps provider identity", async () => {
    const router = new ToolRouter(); await router.register("provider-a", new MockToolProvider("a"), collectContext()); await router.register("provider-b", new MockToolProvider("b"), collectContext());
    expect(router.listTools().map((tool) => tool.canonicalId)).toEqual(["provider-a/add", "provider-a/echo", "provider-a/fail", "provider-a/slow", "provider-b/add", "provider-b/echo", "provider-b/fail", "provider-b/slow"]);
    expect(router.listTools().find((tool) => tool.canonicalId === "provider-a/echo")!.name).toBe("echo");
  });
  it("routes colliding display names to the selected provider", async () => {
    const a = new MockToolProvider("a"); const b = new MockToolProvider("b"); const router = new ToolRouter(); await router.register("a", a, collectContext()); await router.register("b", b, collectContext());
    expect(await router.invoke({ schemaVersion: 1, requestId: "1", toolId: "a/echo", input: { value: "A" } }, collectContext())).toEqual({ ok: true, output: "A" }); expect(await router.invoke({ schemaVersion: 1, requestId: "2", toolId: "b/echo", input: { value: "B" } }, collectContext())).toEqual({ ok: true, output: "B" }); expect(a.calls).toEqual(["echo"]); expect(b.calls).toEqual(["echo"]);
  });
  it("rejects unknown tools, invalid arguments, duplicates, and malformed results", async () => {
    const router = new ToolRouter(); await router.register("provider", new MockToolProvider("provider"), collectContext()); expect((await router.invoke({ schemaVersion: 1, requestId: "1", toolId: "provider/missing", input: null }, collectContext())).error?.code).toBe("CAPABILITY_UNAVAILABLE"); expect((await router.invoke({ schemaVersion: 1, requestId: "2", toolId: "provider/add", input: { left: "x", right: 1 } as never }, collectContext())).error?.code).toBe("VALIDATION_FAILED");
    const duplicate: ToolProvider = { listTools: async () => [{ id: "same", name: "one", version: "1", inputSchema: {} }, { id: "same", name: "two", version: "1", inputSchema: {} }], invoke: async () => ({ ok: true, output: null }) }; await expect(router.register("duplicate", duplicate, collectContext())).rejects.toMatchObject({ error: { code: "CAPABILITY_CONFLICT" } });
    const malformed: ToolProvider = { listTools: async () => [{ id: "bad", name: "bad", version: "1", inputSchema: {} }], invoke: async () => ({ ok: true, output: () => {} } as never) }; const malformedRouter = new ToolRouter(); await malformedRouter.register("malformed", malformed, collectContext()); expect((await malformedRouter.invoke({ schemaVersion: 1, requestId: "3", toolId: "malformed/bad", input: null }, collectContext())).error?.code).toBe("TOOL_FAILED");
  });
  it("invokes exactly once without retries and normalizes controlled failures", async () => { const provider = new MockToolProvider("provider"); const router = new ToolRouter(); await router.register("provider", provider, collectContext()); expect((await router.invoke({ schemaVersion: 1, requestId: "1", toolId: "provider/fail", input: {} }, collectContext())).error?.code).toBe("TOOL_FAILED"); expect(provider.calls).toEqual(["fail"]); });
  it("propagates cancellation and deadlines", async () => {
    const provider = new MockToolProvider("provider"); const router = new ToolRouter(); await router.register("provider", provider, collectContext()); const controller = new AbortController(); const cancelled = router.invoke({ schemaVersion: 1, requestId: "1", toolId: "provider/slow", input: {} }, context(controller.signal)); controller.abort(); expect((await cancelled).error?.code).toBe("CANCELLED"); const timed = await router.invoke({ schemaVersion: 1, requestId: "2", toolId: "provider/slow", input: {} }, context(new AbortController().signal, Date.now() + 1)); expect(timed.error?.code).toBe("TIMEOUT");
  });
});
