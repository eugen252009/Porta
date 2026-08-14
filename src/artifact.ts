import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { JsonValue, ToolContext, ToolDescriptor, ToolInvocation, ToolProvider, ToolResult, failure } from "./contracts.js";
import { SearchDocument, SearchEngine, SearchQuery, SearchResult, SearchSource, LinearTextSearchEngine } from "./search.js";

export type ArtifactKind = "text" | "log" | "diff" | "report" | "json" | "binary";
export interface ArtifactMetadata { readonly artifactId: string; readonly sessionId: string; readonly kind: ArtifactKind; readonly contentType: string; readonly size: number; readonly sha256: string; readonly source: string; readonly createdAt: string; readonly name?: string; readonly executionId?: string; readonly toolCallId?: string }
export interface ArtifactReference extends ArtifactMetadata { readonly uri: string }
export interface ArtifactPutInput { readonly kind: ArtifactKind; readonly contentType: string; readonly source: string; readonly content: string | Uint8Array; readonly name?: string; readonly executionId?: string; readonly toolCallId?: string }
export interface ArtifactRecord { readonly metadata: ArtifactMetadata; readonly content: string | Uint8Array }
export interface ArtifactListOptions { readonly limit?: number; readonly kind?: ArtifactKind; readonly source?: string }
export interface ArtifactStore { put(sessionId: string, input: ArtifactPutInput): Promise<ArtifactReference>; get(sessionId: string, artifactId: string): Promise<ArtifactRecord | undefined>; stat(sessionId: string, artifactId: string): Promise<ArtifactMetadata | undefined>; list(sessionId: string, options?: ArtifactListOptions): Promise<readonly ArtifactMetadata[]> }

export class MemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, Map<string, ArtifactRecord>>();
  constructor(private readonly maxArtifactBytes = 64 * 1024 * 1024) {}
  async put(sessionId: string, input: ArtifactPutInput): Promise<ArtifactReference> { const bytes = toBytes(input.content); if (bytes.byteLength > this.maxArtifactBytes) throw failure("VALIDATION_FAILED", "Artifact exceeds the configured maximum size."); const metadata: ArtifactMetadata = { artifactId: `artifact-${randomUUID()}`, sessionId, kind: input.kind, contentType: input.contentType, size: bytes.byteLength, sha256: sha256(bytes), source: input.source, createdAt: new Date().toISOString(), ...(input.name ? { name: input.name } : {}), ...(input.executionId ? { executionId: input.executionId } : {}), ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}) }; const record = Object.freeze({ metadata: Object.freeze(metadata), content: input.content instanceof Uint8Array ? new Uint8Array(input.content) : input.content }); let session = this.artifacts.get(sessionId); if (!session) { session = new Map(); this.artifacts.set(sessionId, session); } session.set(metadata.artifactId, record); return reference(metadata); }
  async get(sessionId: string, artifactId: string): Promise<ArtifactRecord | undefined> { const record = this.artifacts.get(sessionId)?.get(normalizeId(artifactId)); return record ? { metadata: { ...record.metadata }, content: record.content instanceof Uint8Array ? new Uint8Array(record.content) : record.content } : undefined; }
  async stat(sessionId: string, artifactId: string): Promise<ArtifactMetadata | undefined> { const record = await this.get(sessionId, artifactId); return record?.metadata; }
  async list(sessionId: string, options: ArtifactListOptions = {}): Promise<readonly ArtifactMetadata[]> { const limit = Math.min(options.limit ?? 50, 100); return [...(this.artifacts.get(sessionId)?.values() ?? [])].filter((record) => (!options.kind || record.metadata.kind === options.kind) && (!options.source || record.metadata.source === options.source)).sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt)).slice(0, limit).map((record) => referenceForMetadata(record.metadata) as ArtifactMetadata); }
}

export class ArtifactSearchSource implements SearchSource {
  readonly kind = "artifact";
  constructor(private readonly store: ArtifactStore) {}
  async documents(context: ToolContext): Promise<readonly SearchDocument[]> { const documents: SearchDocument[] = []; for (const metadata of await this.store.list(context.sessionId, { limit: 100 })) { const record = await this.store.get(context.sessionId, metadata.artifactId); if (record && typeof record.content === "string") documents.push({ id: metadata.artifactId, content: record.content }); } return documents; }
}

const readSchema = z.object({ artifactId: z.string().min(1), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict();
const statSchema = z.object({ artifactId: z.string().min(1) }).strict();
const listSchema = z.object({ limit: z.number().int().positive().max(100).optional(), kind: z.enum(["text", "log", "diff", "report", "json", "binary"]).optional(), source: z.string().min(1).optional() }).strict();
const searchSchema = z.object({ query: z.string().min(1), mode: z.enum(["text", "regex"]).optional(), limit: z.number().int().positive().max(50).optional(), maxExcerptChars: z.number().int().positive().max(2000).optional() }).strict();
export class ArtifactToolProvider implements ToolProvider {
  readonly providerId = "artifact";
  constructor(private readonly store: ArtifactStore, private readonly searchEngine: SearchEngine = new LinearTextSearchEngine(), private readonly maxContextBytes = 64 * 1024) {}
  async listTools(_context: ToolContext): Promise<readonly ToolDescriptor[]> { return [
    { id: "read", name: "artifact/read", version: "1", description: "Explicitly read a bounded exact text artifact or line range. Large reads require a range.", inputSchema: { type: "object", required: ["artifactId"], properties: { artifactId: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" } } } },
    { id: "stat", name: "artifact/stat", version: "1", description: "Inspect artifact metadata without loading its content.", inputSchema: { type: "object", required: ["artifactId"], properties: { artifactId: { type: "string" } } } },
    { id: "list", name: "artifact/list", version: "1", description: "List session-scoped artifact metadata without loading contents.", inputSchema: { type: "object", properties: { limit: { type: "integer" }, kind: { type: "string" }, source: { type: "string" } } } },
    { id: "search", name: "artifact/search", version: "1", description: "Search textual artifacts for bounded excerpts, then use artifact/read for exact content.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, mode: { type: "string" }, limit: { type: "integer" }, maxExcerptChars: { type: "integer" } } } },
  ]; }
  async invoke(request: ToolInvocation, context: ToolContext): Promise<ToolResult> { try { if (request.toolId === "read") { const parsed = readSchema.safeParse(request.input); if (!parsed.success) return invalid(parsed.error.issues); const record = await this.store.get(context.sessionId, parsed.data.artifactId); if (!record) return missing(); if (typeof record.content !== "string") return { ok: false, error: failure("VALIDATION_FAILED", "Binary artifacts cannot be hydrated into model text.").error }; const lines = record.content.split("\n"); const selected = parsed.data.startLine ? lines.slice(parsed.data.startLine - 1, parsed.data.endLine ?? parsed.data.startLine) : lines; const content = selected.join("\n"); if (Buffer.byteLength(content) > this.maxContextBytes) return { ok: false, error: failure("VALIDATION_FAILED", "Artifact read exceeds the context bound; request a smaller line range.", false, { maxContextBytes: this.maxContextBytes, size: Buffer.byteLength(content) }).error }; return { ok: true, output: { artifactId: record.metadata.artifactId, content, startLine: parsed.data.startLine ?? 1, endLine: parsed.data.endLine ?? lines.length, exact: true } as unknown as JsonValue }; }
    if (request.toolId === "stat") { const parsed = statSchema.safeParse(request.input); if (!parsed.success) return invalid(parsed.error.issues); const metadata = await this.store.stat(context.sessionId, parsed.data.artifactId); return metadata ? { ok: true, output: metadata as unknown as JsonValue } : missing(); }
    if (request.toolId === "list") { const parsed = listSchema.safeParse(request.input); if (!parsed.success) return invalid(parsed.error.issues); return { ok: true, output: await this.store.list(context.sessionId, parsed.data) as unknown as JsonValue }; }
    if (request.toolId === "search") { const parsed = searchSchema.safeParse(request.input); if (!parsed.success) return invalid(parsed.error.issues); const result: SearchResult = await this.searchEngine.search(new ArtifactSearchSource(this.store), parsed.data as SearchQuery, context); return { ok: true, output: result as unknown as JsonValue }; }
    return missing();
  } catch (error) { return { ok: false, error: error instanceof Error && "error" in error ? (error as { error: import("./contracts.js").HarnessError }).error : failure("TOOL_FAILED", error instanceof Error ? error.message : "Artifact operation failed.").error }; } }
}
export function toBytes(content: string | Uint8Array): Uint8Array { return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content); }
export function sha256(content: Uint8Array): string { return createHash("sha256").update(content).digest("hex"); }
export function normalizeId(value: string): string { return value.startsWith("artifact://") ? value.slice("artifact://".length) : value; }
export function uri(id: string): string { return `artifact://${id}`; }
export function referenceForMetadata(metadata: ArtifactMetadata): ArtifactReference { return { ...metadata, uri: uri(metadata.artifactId) }; }
function reference(metadata: ArtifactMetadata): ArtifactReference { return referenceForMetadata(metadata); }
function missing(): ToolResult { return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", "Artifact was not found for this session.").error }; }
function invalid(issues: unknown): ToolResult { return { ok: false, error: failure("VALIDATION_FAILED", "Artifact arguments are invalid.", false, { issues }).error }; }
