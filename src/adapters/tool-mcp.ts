import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import AjvModule from "ajv";
import { z } from "zod";
import { HarnessFailure, HealthCheckable, HealthStatus, JsonValue, ToolContext, ToolDescriptor, ToolInvocation, ToolProvider, ToolResult, id, jsonValueSchema, failure, toolDescriptorSchema } from "../contracts.js";

export interface McpStdioConfig { providerId: string; command: string; args?: readonly string[]; cwd?: string; env?: Record<string, string> }
export const mcpStdioConfigSchema = z.object({ providerId: id, command: z.string().min(1), args: z.array(z.string()).optional(), cwd: z.string().min(1).optional(), env: z.record(z.string()).optional() });

export interface McpConnection { connect(): Promise<void>; listTools(cursor?: string, signal?: AbortSignal): Promise<{ tools: readonly McpTool[]; nextCursor?: string }>; callTool(name: string, input: JsonValue, signal?: AbortSignal, timeout?: number): Promise<McpToolResult>; close(): Promise<void> }
export interface McpTool { name: string; description?: string; inputSchema: JsonValue; outputSchema?: JsonValue }
export interface McpToolResult { content: readonly JsonValue[]; structuredContent?: JsonValue; isError?: boolean }
export type McpConnectionFactory = (config: McpStdioConfig) => McpConnection;

const defaultConnectionFactory: McpConnectionFactory = (config) => {
  const client = new Client({ name: "generic-agent-harness", version: "1" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: config.command, args: [...(config.args ?? [])], cwd: config.cwd, env: config.env, stderr: "pipe" });
  return { connect: () => client.connect(transport), listTools: async (cursor, signal) => { const result = await client.listTools(cursor ? { cursor } : undefined, signal ? { signal } : undefined); return { tools: result.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as JsonValue, outputSchema: tool.outputSchema as JsonValue | undefined })), nextCursor: result.nextCursor }; }, callTool: async (name, input, signal, timeout) => { const result = await client.callTool({ name, arguments: input as Record<string, unknown> }, undefined, { signal, timeout }); return { content: result.content as JsonValue[], structuredContent: result.structuredContent as JsonValue | undefined, isError: typeof result.isError === "boolean" ? result.isError : undefined }; }, close: () => client.close() };
};

export class MCPToolProvider implements ToolProvider, HealthCheckable {
  private readonly config: McpStdioConfig; private readonly factory: McpConnectionFactory; private readonly validator = new (AjvModule.default ?? AjvModule)({ allErrors: true }); private connection?: McpConnection; private connecting?: Promise<McpConnection>; private discovered = new Map<string, ToolDescriptor>();
  constructor(config: McpStdioConfig, factory: McpConnectionFactory = defaultConnectionFactory) { this.config = mcpStdioConfigSchema.parse(config); this.factory = factory; }
  get providerId(): string { return this.config.providerId; }
  async connect(): Promise<void> { await this.ensureConnection(); }
  async close(): Promise<void> { const connection = this.connection; this.connection = undefined; this.connecting = undefined; this.discovered.clear(); if (connection) await connection.close(); }
  async listTools(context: ToolContext): Promise<readonly ToolDescriptor[]> {
    const connection = await this.ensureConnection(); const descriptors: ToolDescriptor[] = []; const seen = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
    do { if (cursor) { if (cursors.has(cursor)) throw failure("TOOL_FAILED", "MCP tool discovery returned a cursor cycle."); cursors.add(cursor); } const page = await connection.listTools(cursor, context.signal); for (const tool of page.tools) { if (seen.has(tool.name)) throw failure("TOOL_FAILED", `MCP provider returned duplicate tool '${tool.name}'.`); seen.add(tool.name); const inputSchema = jsonValueSchema.parse(tool.inputSchema); const descriptor = { id: tool.name, name: tool.name, version: "1", ...(tool.description ? { description: tool.description } : {}), inputSchema, ...(tool.outputSchema ? { metadata: { outputSchema: jsonValueSchema.parse(tool.outputSchema) } } : {}) }; if (!toolDescriptorSchema.safeParse(descriptor).success) throw failure("TOOL_FAILED", `MCP provider returned an invalid tool descriptor for '${tool.name}'.`); descriptors.push(descriptor); } cursor = page.nextCursor; } while (cursor);
    this.discovered = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor])); return [...descriptors].sort((left, right) => left.id.localeCompare(right.id));
  }
  async invoke(request: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    const localId = this.localId(request.toolId); if (!localId) return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", `Tool '${request.toolId}' does not belong to provider '${this.config.providerId}'.`).error };
    const controller = new AbortController(); const abort = () => controller.abort(); context.signal.addEventListener("abort", abort, { once: true }); const timeout = context.deadline === undefined ? undefined : Math.max(0, context.deadline - Date.now()); const timer = timeout === undefined ? undefined : setTimeout(() => controller.abort(), timeout);
    try { if (!this.discovered.has(localId)) await this.listTools(context); const descriptor = this.discovered.get(localId); if (!descriptor) return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", `Tool '${localId}' is unavailable.`).error }; const validator = this.validator.compile(descriptor.inputSchema as object); if (!validator(request.input)) return { ok: false, error: failure("VALIDATION_FAILED", `Arguments for tool '${localId}' are invalid.`, false, { errors: validator.errors }).error }; const result = await (await this.ensureConnection()).callTool(localId, request.input, controller.signal, timeout); const output = result.structuredContent ?? result.content; if (!jsonValueSchema.safeParse(output).success) return { ok: false, error: failure("TOOL_FAILED", "MCP returned a non-serializable tool result.").error }; if (result.isError) return { ok: false, output, error: failure("TOOL_FAILED", "MCP tool reported an execution error.").error }; return { ok: true, output }; }
    catch (error) { if (error instanceof HarnessFailure) return { ok: false, error: error.error }; if (context.signal.aborted) return { ok: false, error: failure("CANCELLED", "MCP tool invocation was cancelled.").error }; if (context.deadline !== undefined && context.deadline <= Date.now()) return { ok: false, error: failure("TIMEOUT", "MCP tool invocation exceeded its deadline.", true).error }; return { ok: false, error: failure("TOOL_FAILED", error instanceof Error ? error.message : "MCP tool invocation failed.", true).error }; }
    finally { context.signal.removeEventListener("abort", abort); if (timer !== undefined) clearTimeout(timer); }
  }
  async health(): Promise<HealthStatus> { try { await this.connect(); const tools = await this.listTools({ traceId: "health", sessionId: "health", executionId: "health", signal: new AbortController().signal }); return { status: tools.length >= 0 ? "healthy" : "unhealthy" }; } catch { return { status: "unhealthy", reason: "provider-error", message: "MCP provider could not initialize." }; } }
  private localId(toolId: string): string | undefined { const prefix = `${this.config.providerId}/`; if (!toolId.includes("/")) return toolId; return toolId.startsWith(prefix) ? toolId.slice(prefix.length) : undefined; }
  private async ensureConnection(): Promise<McpConnection> { if (this.connection) return this.connection; if (!this.connecting) { const connection = this.factory(this.config); this.connecting = connection.connect().then(() => { this.connection = connection; return connection; }); } return this.connecting; }
}

export function mcpToolPlugin(provider: MCPToolProvider): import("../contracts.js").HarnessPlugin { return { manifest: { schemaVersion: 1, id: `tools.mcp.${provider.providerId}`, version: "1", provides: [{ id: "tools.discovery", version: "1" }, { id: "tools.invoke", version: "1" }], requires: [] }, register(registrar) { registrar.provide({ id: "tools.discovery", version: "1" }, provider); registrar.provide({ id: "tools.invoke", version: "1" }, provider); } }; }
