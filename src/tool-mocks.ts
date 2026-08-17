import { z } from "zod";
import { HarnessPlugin, ToolContext, ToolDescriptor, ToolInvocation, ToolProvider, ToolResult, failure } from "./contracts.js";

const echoSchema = z.object({ value: z.unknown() });
const addSchema = z.object({ left: z.number(), right: z.number() });
const toolInputSchemas = { echo: { type: "object", properties: { value: {} } }, add: { type: "object", properties: { left: { type: "number" }, right: { type: "number" } } }, fail: { type: "object" }, slow: { type: "object" } } as const;

export class MockToolProvider implements ToolProvider {
  readonly calls: string[] = [];
  constructor(readonly providerName: string, private readonly includeEcho = true) {}
  async listTools(_context: ToolContext): Promise<readonly ToolDescriptor[]> {
    const descriptors: ToolDescriptor[] = [];
    if (this.includeEcho) descriptors.push({ id: "echo", name: "echo", version: "1", description: "Returns its input.", inputSchema: toolInputSchemas.echo });
    descriptors.push({ id: "add", name: "add", version: "1", inputSchema: toolInputSchemas.add }, { id: "fail", name: "fail", version: "1", inputSchema: toolInputSchemas.fail }, { id: "slow", name: "slow", version: "1", inputSchema: toolInputSchemas.slow });
    return descriptors;
  }
  private resolveId(canonicalToolId: string): string { const slash = canonicalToolId.lastIndexOf("/"); return slash === -1 ? canonicalToolId : canonicalToolId.slice(slash + 1); }
  async invoke(request: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    this.calls.push(request.toolId);
    const id = this.resolveId(request.toolId);
    if (id === "echo") { const parsed = echoSchema.safeParse(request.input); return parsed.success ? { ok: true, output: parsed.data.value as never } : { ok: false, error: failure("VALIDATION_FAILED", "Echo arguments are invalid.").error }; }
    if (id === "add") { const parsed = addSchema.safeParse(request.input); return parsed.success ? { ok: true, output: parsed.data.left + parsed.data.right } : { ok: false, error: failure("VALIDATION_FAILED", "Add arguments are invalid.").error }; }
    if (id === "fail") return { ok: false, error: failure("TOOL_FAILED", `Mock tool '${this.providerName}' failed.`).error };
    if (id === "slow") return this.waitForTermination(context);
    return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", `Tool '${request.toolId}' is unavailable.`).error };
  }
  private waitForTermination(context: ToolContext): Promise<ToolResult> { return new Promise((resolve) => { const finish = (result: ToolResult) => { context.signal.removeEventListener("abort", onAbort); if (timer) clearTimeout(timer); resolve(result); }; const onAbort = () => finish({ ok: false, error: failure("CANCELLED", "Tool invocation was cancelled.").error }); const remaining = context.deadline === undefined ? undefined : context.deadline - Date.now(); const timer = remaining === undefined ? undefined : setTimeout(() => finish({ ok: false, error: failure("TIMEOUT", "Tool invocation exceeded its deadline.", true).error }), Math.max(0, remaining)); context.signal.addEventListener("abort", onAbort, { once: true }); }); }
}

export function mockToolPlugin(provider: ToolProvider): HarnessPlugin { return { manifest: { schemaVersion: 1, id: "tools.mock", version: "1", provides: [{ id: "tools.discovery", version: "1" }, { id: "tools.invoke", version: "1" }], requires: [] }, register(registrar) { registrar.provide({ id: "tools.discovery", version: "1" }, provider); registrar.provide({ id: "tools.invoke", version: "1" }, provider); } }; }
