import { describe, expect, it } from "vitest";
import { AgentOrchestrator } from "../src/agent.js";
import { StaticApprovalProvider, StaticToolAuthorizationPolicy } from "../src/authorization-mocks.js";
import { ResultAwareToolModelProvider, ScriptedToolModelProvider } from "../src/agent-mocks.js";
import { MockToolProvider } from "../src/tool-mocks.js";
import { ToolRouter } from "../src/tools.js";
import { ToolContext } from "../src/index.js";
const context = (signal = new AbortController().signal, deadline?: number): ToolContext => ({ traceId: "trace", sessionId: "session", executionId: "agent", signal, deadline });
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const value of source) result.push(value); return result; }
async function router() { const tools = new ToolRouter(); await tools.register("provider", new MockToolProvider("provider"), context()); return tools; }
describe("AgentExecution", () => {
  it("completes text-only execution", async () => { const execution = new AgentOrchestrator(new ScriptedToolModelProvider([[{ type: "text", text: "hello" }]])).create("input", context()); const events = await collect(execution.events()); expect((await execution.result()).status).toBe("completed"); expect(events.map((event) => event.type)).toEqual(["started", "model-started", "model-text", "completed"]); });
  it("performs a tool round trip and correlates result", async () => { const tools = await router(); const model = new ResultAwareToolModelProvider(); const execution = new AgentOrchestrator(model, tools).create("input", context(), tools.listTools()); const events = await collect(execution.events()); expect((await execution.result()).text).toBe("sum accepted"); expect(events.map((event) => event.type)).toEqual(["started", "model-started", "tool-requested", "tool-started", "tool-completed", "model-started", "model-text", "completed"]); expect(model.turns).toBe(2); });
  it("supports multiple calls sequentially", async () => { const tools = await router(); const model = new ScriptedToolModelProvider([[{ type: "tool", toolId: "provider/echo", input: { value: "a" }, id: "a" }, { type: "tool", toolId: "provider/add", input: { left: 1, right: 2 }, id: "b" }], [{ type: "text", text: "done" }]]); const execution = new AgentOrchestrator(model, tools).create("input", context(), tools.listTools()); const events = await collect(execution.events()); expect((await execution.result()).status).toBe("completed"); expect(events.filter((event) => event.type === "tool-completed")).toHaveLength(2); });
  it("feeds controlled tool failures back to the model", async () => { const tools = await router(); const model = new ScriptedToolModelProvider([[{ type: "tool", toolId: "provider/missing", input: {}, id: "missing" }], [{ type: "text", text: "recovered" }]]); const execution = new AgentOrchestrator(model, tools).create("input", context(), tools.listTools()); expect((await execution.result()).text).toBe("recovered"); });
  it("denies before invocation and exposes the denial to the model", async () => { const tools = await router(); const model = new ScriptedToolModelProvider([[{ type: "tool", toolId: "provider/echo", input: { value: "secret" }, id: "denied" }], [{ type: "text", text: "denial handled" }]]); const execution = new AgentOrchestrator(model, tools, undefined, { policy: new StaticToolAuthorizationPolicy("deny") }).create("input", context(), tools.listTools()); expect((await execution.result()).text).toBe("denial handled"); expect(model.received[1]?.messages?.at(-1)).toMatchObject({ role: "tool", result: { error: { code: "AUTHORIZATION_DENIED" } } }); expect(tools.descriptorFor("provider/echo")).toBeDefined(); });
  it("requires approval and preserves canonical identity and input", async () => { const tools = await router(); const approvals = new StaticApprovalProvider(true); const seen: unknown[] = []; const policy = { authorize: async (request: import("../src/index.js").ToolAuthorizationRequest) => { seen.push(request); return "require-approval" as const; } }; const model = new ScriptedToolModelProvider([[{ type: "tool", toolId: "provider/echo", input: { value: "kept" }, id: "call-approval" }], [{ type: "text", text: "approved" }]]); const execution = new AgentOrchestrator(model, tools, undefined, { policy, approvalProvider: approvals }).create("input", context(), tools.listTools()); expect((await execution.result()).text).toBe("approved"); expect((seen[0] as import("../src/index.js").ToolAuthorizationRequest).invocation).toMatchObject({ toolId: "provider/echo", input: { value: "kept" } }); expect(approvals.requests[0]).toMatchObject({ toolCallId: "call-approval", invocation: { toolId: "provider/echo" } }); expect(approvals.requests[0]?.approvalId).not.toBe("call-approval"); });
  it("terminates while approval is pending without invoking the tool", async () => { const tools = await router(); let release!: () => void; const approval = { approve: async () => new Promise<{ approved: boolean }>((resolve) => { release = () => resolve({ approved: true }); }) }; const model = new ScriptedToolModelProvider([[{ type: "tool", toolId: "provider/echo", input: { value: "never" }, id: "pending" }]]); const execution = new AgentOrchestrator(model, tools, undefined, { policy: new StaticToolAuthorizationPolicy("require-approval"), approvalProvider: approval }).create("input", context(), tools.listTools()); await new Promise((resolve) => setTimeout(resolve, 0)); await execution.cancel(); expect((await execution.result()).status).toBe("cancelled"); expect(tools.descriptorFor("provider/echo")).toBeDefined(); release(); });
  it("rejects duplicate calls and enforces limits", async () => { const tools = await router(); const duplicate = new ScriptedToolModelProvider([[{ type: "tool", toolId: "provider/echo", input: { value: 1 }, id: "same" }, { type: "tool", toolId: "provider/echo", input: { value: 2 }, id: "same" }]]); expect((await new AgentOrchestrator(duplicate, tools).create("input", context(), tools.listTools()).result()).status).toBe("failed"); const limited = new ScriptedToolModelProvider([[{ type: "tool", toolId: "provider/echo", input: {}, id: "one" }], [{ type: "text", text: "never" }]]); expect((await new AgentOrchestrator(limited, tools, { maxSteps: 1, maxToolCalls: 5 }).create("input", context(), tools.listTools()).result()).status).toBe("limit-reached"); });
  it("cancels during model and tool", async () => { const controller = new AbortController(); const execution = new AgentOrchestrator(new ScriptedToolModelProvider([[{ type: "text", text: "x" }]])).create("input", context(controller.signal)); controller.abort(); expect((await execution.result()).status).toBe("cancelled"); const tools = await router(); const active = new AgentOrchestrator(new ScriptedToolModelProvider([[{ type: "tool", toolId: "provider/slow", input: {}, id: "slow" }]]), tools).create("input", context(), tools.listTools()); await new Promise((resolve) => setTimeout(resolve, 0)); const events = active.events(); await events[Symbol.asyncIterator]().next(); await active.cancel(); expect((await active.result()).status).toBe("cancelled"); });
  it("enforces global deadline", async () => { const tools = await router(); const execution = new AgentOrchestrator(new ScriptedToolModelProvider([[{ type: "tool", toolId: "provider/slow", input: {}, id: "slow" }]]), tools).create("input", context(new AbortController().signal, Date.now() + 2), tools.listTools()); expect((await execution.result()).status).toBe("timed-out"); });
});

const live =
  process.env.RUN_AGENT_E2E_TESTS === "1"
    ? describe
    : describe.skip;

live("Ollama to MCP agent composition", () => {
  it(
    "uses real model and MCP tool through the generic agent loop",
    async () => {
      const { MCPToolProvider } =
        await import("../src/adapters/tool-mcp.js");

      const { OllamaModelProvider } =
        await import("../src/adapters/model-ollama.js");

      const { ToolRouter } =
        await import("../src/tools.js");

      const provider = new MCPToolProvider({
        providerId: "fixture",
        command: process.execPath,
        args: [
          new URL(
            "../dist/tests/mcp-fixture-server.js",
            import.meta.url,
          ).pathname,
        ],
      });

      try {
        const router = new ToolRouter();

        await router.register(
          "fixture",
          provider,
          context(),
        );

        const model = new OllamaModelProvider({
          baseUrl:
            process.env.OLLAMA_BASE_URL ??
            "http://localhost:11434",

          model:
            process.env.OLLAMA_MODEL ?? "",
        });

        const health = await model.health();

        expect(health.status).toBe("healthy");

        await provider.listTools(context());

        const execution = new AgentOrchestrator(
          model,
          router,
          {
            maxSteps: 4,
            maxToolCalls: 2,
          },
        ).create(
          "Use the provided echo tool with value HARNESS_AGENT_SENTINEL and report the exact returned value.",
          {
            ...context(),
            deadline: Date.now() + 60_000,
          },
          router.listTools(),
        );

        const result = await execution.result();

        expect(result.status).toBe("completed");
        expect(result.text).toContain(
          "HARNESS_AGENT_SENTINEL",
        );
      } finally {
        await provider.close();
      }
    },
    90_000,
  );
});
