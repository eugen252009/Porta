import { z } from "zod";
import { JsonValue, ToolContext, ToolDescriptor, ToolInvocation, ToolProvider, ToolResult, failure } from "./contracts.js";

export interface ScratchpadMetadata { key: string; bytes: number; createdAt: string; updatedAt: string }
export interface ScratchpadEntry extends ScratchpadMetadata { sessionId: string; content: string }
export interface ScratchpadStore {
  write(sessionId: string, key: string, content: string): Promise<ScratchpadMetadata>;
  append(sessionId: string, key: string, content: string): Promise<ScratchpadMetadata>;
  read(sessionId: string, key: string): Promise<ScratchpadEntry | undefined>;
  list(sessionId: string): Promise<readonly ScratchpadMetadata[]>;
}

export class MemoryScratchpadStore implements ScratchpadStore {
  private readonly entries = new Map<string, Map<string, ScratchpadEntry>>();
  async write(sessionId: string, key: string, content: string): Promise<ScratchpadMetadata> { const now = new Date().toISOString(); const entry = { sessionId, key, content, bytes: Buffer.byteLength(content), createdAt: this.entries.get(sessionId)?.get(key)?.createdAt ?? now, updatedAt: now }; this.forSession(sessionId).set(key, Object.freeze(entry)); return metadata(entry); }
  async append(sessionId: string, key: string, content: string): Promise<ScratchpadMetadata> { const existing = this.entries.get(sessionId)?.get(key); if (!existing) throw new Error(`Scratchpad key '${key}' was not found.`); return this.write(sessionId, key, `${existing.content}${content}`); }
  async read(sessionId: string, key: string): Promise<ScratchpadEntry | undefined> { const entry = this.entries.get(sessionId)?.get(key); return entry ? { ...entry } : undefined; }
  async list(sessionId: string): Promise<readonly ScratchpadMetadata[]> { return [...(this.entries.get(sessionId)?.values() ?? [])].sort((a, b) => a.key.localeCompare(b.key)).map(metadata); }
  private forSession(sessionId: string) { let entries = this.entries.get(sessionId); if (!entries) { entries = new Map(); this.entries.set(sessionId, entries); } return entries; }
}

const keySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const writeSchema = z.object({ key: keySchema, content: z.string() }).strict();
const readSchema = z.object({ key: keySchema }).strict();

export class ScratchpadToolProvider implements ToolProvider {
  readonly providerId = "scratchpad";
  constructor(private readonly store: ScratchpadStore) {}
  async listTools(_context: ToolContext): Promise<readonly ToolDescriptor[]> {
    return [
      { id: "write", name: "scratchpad/write", version: "1", description: "Write or replace an agent-authored working note. The content remains off-context until explicitly read.", inputSchema: { type: "object", required: ["key", "content"], properties: { key: { type: "string" }, content: { type: "string" } } } },
      { id: "append", name: "scratchpad/append", version: "1", description: "Append agent-authored working notes to an existing logical key.", inputSchema: { type: "object", required: ["key", "content"], properties: { key: { type: "string" }, content: { type: "string" } } } },
      { id: "read", name: "scratchpad/read", version: "1", description: "Explicitly bring one off-context working note into the active model context.", inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string" } } } },
      { id: "list", name: "scratchpad/list", version: "1", description: "List available working-note keys and metadata without returning their contents.", inputSchema: { type: "object", properties: {} } },
    ];
  }
  async invoke(request: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    try {
      if (request.toolId === "write" || request.toolId === "append") {
        const parsed = writeSchema.safeParse(request.input); if (!parsed.success) return invalid(parsed.error.issues);
        const metadata = request.toolId === "write" ? await this.store.write(context.sessionId, parsed.data.key, parsed.data.content) : await this.store.append(context.sessionId, parsed.data.key, parsed.data.content);
        return { ok: true, output: { key: metadata.key, stored: true, bytes: metadata.bytes, updatedAt: metadata.updatedAt } };
      }
      if (request.toolId === "read") {
        const parsed = readSchema.safeParse(request.input); if (!parsed.success) return invalid(parsed.error.issues);
        const entry = await this.store.read(context.sessionId, parsed.data.key); if (!entry) return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", `Scratchpad key '${parsed.data.key}' was not found.`).error };
        return { ok: true, output: { key: entry.key, content: entry.content, bytes: entry.bytes, updatedAt: entry.updatedAt } };
      }
      if (request.toolId === "list") return { ok: true, output: (await this.store.list(context.sessionId)) as unknown as JsonValue };
      return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", `Scratchpad tool '${request.toolId}' is unavailable.`).error };
    } catch (error) { return { ok: false, error: error instanceof Error && "error" in error ? (error as { error: import("./contracts.js").HarnessError }).error : failure("TOOL_FAILED", error instanceof Error ? error.message : "Scratchpad operation failed.").error }; }
  }
}
function metadata(entry: ScratchpadEntry): ScratchpadMetadata { return { key: entry.key, bytes: entry.bytes, createdAt: entry.createdAt, updatedAt: entry.updatedAt }; }
function invalid(issues: unknown): ToolResult { return { ok: false, error: failure("VALIDATION_FAILED", "Scratchpad arguments are invalid.", false, { issues }).error }; }
