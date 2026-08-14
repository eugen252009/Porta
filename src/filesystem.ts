import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { ContentReductionRequest, ContentReductionResult, ContentReducer } from "./content-reducer.js";
import { LinearTextSearchEngine, SearchDocument, SearchEngine, SearchQuery, SearchResult, SearchSource } from "./search.js";
import { JsonValue, ModelContext, ModelProvider, ToolContext, ToolDescriptor, ToolInvocation, ToolProvider, ToolResult, failure } from "./contracts.js";
import { DirectFilesystemMutationEngine, MutationEngine, MutationPatchRequest, MutationWriteRequest, contentHash } from "./mutation.js";
import { WorkspaceBoundary } from "./workspace.js";

export interface FilesystemProviderConfig { root: string; maxExactContextBytes?: number; maxReadBytes?: number; maxSummaryChars?: number; mutation?: { enabled?: boolean; maxWriteBytes?: number; maxPatchTargetBytes?: number } }
const configSchema = z.object({ root: z.string().min(1), maxExactContextBytes: z.number().int().positive().default(65536), maxReadBytes: z.number().int().positive().default(8 * 1024 * 1024), maxSummaryChars: z.number().int().positive().default(12000), mutation: z.object({ enabled: z.boolean().default(false), maxWriteBytes: z.number().int().positive().default(2 * 1024 * 1024), maxPatchTargetBytes: z.number().int().positive().default(8 * 1024 * 1024) }).optional() });
const readSchema = z.object({ path: z.string().min(1), mode: z.enum(["exact", "summary"]).default("exact"), range: z.object({ startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).optional() }).strict();
const pathSchema = z.object({ path: z.string().min(1) }).strict();
const writeSchema = z.object({ path: z.string().min(1), content: z.string(), mode: z.enum(["create", "replace", "create-or-replace"]), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const patchSchema = z.object({ path: z.string().min(1), edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string(), expectedOccurrences: z.number().int().positive().optional() })).min(1), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const searchSchema = z.object({ query: z.string().min(1), mode: z.enum(["text", "regex"]).optional(), limit: z.number().int().positive().optional(), maxExcerptChars: z.number().int().positive().optional() }).strict();

export class FilesystemSearchSource implements SearchSource {
  readonly kind = "filesystem";
  constructor(readonly nativeRoot: string, private readonly maxReadBytes = 8 * 1024 * 1024) {}
  async documents(context: ToolContext): Promise<readonly SearchDocument[]> { const documents: SearchDocument[] = []; await this.walk(this.nativeRoot, "", documents, context); return documents; }
  private async walk(directory: string, prefix: string, documents: SearchDocument[], context: ToolContext): Promise<void> { if (context.signal.aborted) throw failure("CANCELLED", "Search was cancelled."); for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { if (entry.isSymbolicLink()) continue; const relativePath = prefix ? join(prefix, entry.name) : entry.name; const target = join(directory, entry.name); if (entry.isDirectory()) await this.walk(target, relativePath, documents, context); else if (entry.isFile()) { const stat = await fs.stat(target); if (stat.size > this.maxReadBytes) continue; const buffer = await fs.readFile(target); if (!buffer.includes(0)) documents.push({ id: relativePath, content: buffer.toString("utf8") }); } } }
}

export class FilesystemToolProvider implements ToolProvider {
  readonly providerId = "filesystem";
  private readonly config: z.infer<typeof configSchema>;
  private readonly root: string;
  private readonly boundary: WorkspaceBoundary;
  private readonly searchSource: FilesystemSearchSource;
  private readonly mutationEngine?: MutationEngine;
  constructor(config: FilesystemProviderConfig, private readonly reducer: ContentReducer = new DeterministicContentReducer(), private readonly searchEngine: SearchEngine = new LinearTextSearchEngine(), mutationEngine?: MutationEngine) {
    this.config = configSchema.parse(config);
    this.boundary = new WorkspaceBoundary(this.config.root); this.root = this.boundary.root;
    this.searchSource = new FilesystemSearchSource(this.root, this.config.maxReadBytes);
    if (this.config.mutation?.enabled) this.mutationEngine = mutationEngine ?? new DirectFilesystemMutationEngine(this.boundary, { maxWriteBytes: this.config.mutation.maxWriteBytes, maxPatchTargetBytes: this.config.mutation.maxPatchTargetBytes });
  }
  async listTools(_context: ToolContext): Promise<readonly ToolDescriptor[]> {
    return [
      { id: "read_file", name: "filesystem/read_file", version: "1", description: "Read a text file. Use exact when exact source is required; use summary when semantic understanding is enough. Optional ranges are 1-based inclusive. Large exact content is rejected rather than silently truncated.", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, mode: { enum: ["exact", "summary"] }, range: { type: "object" } } } },
      { id: "list_directory", name: "filesystem/list_directory", version: "1", description: "List one directory deterministically without recursive traversal.", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
      { id: "stat", name: "filesystem/stat", version: "1", description: "Return safe metadata for a file or directory.", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
      { id: "search", name: "filesystem/search", version: "1", description: "Search the configured workspace for relevant text before calling read_file. Results are bounded excerpts with paths and line numbers.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, mode: { enum: ["text", "regex"] }, limit: { type: "integer" }, maxExcerptChars: { type: "integer" } } } },
      ...(this.mutationEngine ? [{ id: "write_file", name: "filesystem/write_file", version: "1", description: "Create or replace an entire UTF-8 text file inside the configured workspace. Use an expected hash when modifying a file previously inspected.", inputSchema: { type: "object", required: ["path", "content", "mode"], properties: { path: { type: "string" }, content: { type: "string" }, mode: { enum: ["create", "replace", "create-or-replace"] }, expectedHash: { type: "string" } } } }, { id: "patch_file", name: "filesystem/patch_file", version: "1", description: "Apply targeted validated edits to one existing UTF-8 text file. Use expectedHash to reject stale edits; ambiguous or missing context fails closed.", inputSchema: { type: "object", required: ["path", "edits"], properties: { path: { type: "string" }, edits: { type: "array" }, expectedHash: { type: "string" } } } }] : []),
    ];
  }
  async invoke(request: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    try {
      if (request.toolId === "read_file") return await this.readFile(request.input, context);
      if (request.toolId === "list_directory") return await this.listDirectory(request.input);
      if (request.toolId === "stat") return await this.stat(request.input);
      if (request.toolId === "search") return await this.search(request.input, context);
      if (request.toolId === "write_file") return await this.writeFile(request.input, context);
      if (request.toolId === "patch_file") return await this.patchFile(request.input, context);
      return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", `Filesystem tool '${request.toolId}' is unavailable.`).error };
    } catch (error) { return { ok: false, error: error instanceof Error && "error" in error ? (error as { error: import("./contracts.js").HarnessError }).error : failure("TOOL_FAILED", error instanceof Error ? error.message : "Filesystem operation failed.").error }; }
  }
  private async readFile(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    const parsed = readSchema.safeParse(input); if (!parsed.success) return invalid(parsed.error.issues);
    const target = await this.safePath(parsed.data.path); const info = await fs.stat(target); if (!info.isFile()) return { ok: false, error: failure("VALIDATION_FAILED", "read_file requires a regular file.").error };
    if (info.size > this.config.maxReadBytes) return { ok: false, error: failure("TOOL_FAILED", `File exceeds the maximum readable size of ${this.config.maxReadBytes} bytes.`).error };
    const content = await fs.readFile(target); if (content.includes(0)) return { ok: false, error: failure("TOOL_FAILED", "Binary files are not supported by the text filesystem tool.").error };
    const text = content.toString("utf8"); const selected = selectRange(text, parsed.data.range); if (selected.error) return { ok: false, error: selected.error };
    if (parsed.data.mode === "exact") {
      if (Buffer.byteLength(selected.content) > this.config.maxExactContextBytes) return { ok: false, error: failure("TOOL_FAILED", `Exact content exceeds the ${this.config.maxExactContextBytes}-byte context limit; use summary, exact line ranges, or a scratchpad note.`).error };
      return { ok: true, output: { path: parsed.data.path, mode: "exact", content: selected.content, bytes: Buffer.byteLength(selected.content), sha256: contentHash(content), ...(parsed.data.range ? { range: parsed.data.range } : {}) } };
    }
    const reduction: ContentReductionRequest = { content: selected.content, purpose: "summary", source: { kind: "file", path: parsed.data.path }, maxChars: this.config.maxSummaryChars };
    const result = await this.reducer.reduce(reduction, context);
    return { ok: true, output: { path: parsed.data.path, mode: "summary", summary: result.content, sourceBytes: content.byteLength, sourceChars: result.sourceChars } };
  }
  private async listDirectory(input: JsonValue): Promise<ToolResult> {
    const parsed = pathSchema.safeParse(input); if (!parsed.success) return invalid(parsed.error.issues); const target = await this.safePath(parsed.data.path); const info = await fs.stat(target); if (!info.isDirectory()) return { ok: false, error: failure("VALIDATION_FAILED", "list_directory requires a directory.").error };
    const names = (await fs.readdir(target)).sort((a, b) => a.localeCompare(b)); const entries = [];
    for (const name of names) { const entryPath = join(target, name); const entry = await fs.lstat(entryPath); const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other"; entries.push({ name, kind, ...(entry.isFile() ? { size: entry.size } : {}) }); }
    return { ok: true, output: { path: parsed.data.path, entries } };
  }
  private async search(input: JsonValue, context: ToolContext): Promise<ToolResult> { const parsed = searchSchema.safeParse(input); if (!parsed.success) return invalid(parsed.error.issues); const result: SearchResult = await this.searchEngine.search(this.searchSource, parsed.data as SearchQuery, context); return { ok: true, output: result as unknown as JsonValue }; }
  private async writeFile(input: JsonValue, context: ToolContext): Promise<ToolResult> { if (!this.mutationEngine) return unavailableMutation(); const parsed = writeSchema.safeParse(input); if (!parsed.success) return invalid(parsed.error.issues); const result = await this.mutationEngine.write(parsed.data as MutationWriteRequest, context); return { ok: true, output: result as unknown as JsonValue }; }
  private async patchFile(input: JsonValue, context: ToolContext): Promise<ToolResult> { if (!this.mutationEngine) return unavailableMutation(); const parsed = patchSchema.safeParse(input); if (!parsed.success) return invalid(parsed.error.issues); const result = await this.mutationEngine.patch(parsed.data as MutationPatchRequest, context); return { ok: true, output: result as unknown as JsonValue }; }
  private async stat(input: JsonValue): Promise<ToolResult> {
    const parsed = pathSchema.safeParse(input); if (!parsed.success) return invalid(parsed.error.issues); const target = await this.safePath(parsed.data.path); const entry = await fs.stat(target); const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"; const sha256 = entry.isFile() && entry.size <= this.config.maxReadBytes ? contentHash(await fs.readFile(target)) : undefined; return { ok: true, output: { path: parsed.data.path, kind, size: entry.size, ...(sha256 ? { sha256 } : {}) } };
  }
  private async safePath(requested: string): Promise<string> { return this.boundary.resolveRead(requested); }
}

export class DeterministicContentReducer implements ContentReducer {
  async reduce(request: ContentReductionRequest): Promise<ContentReductionResult> { const max = request.maxChars ?? 12000; const normalized = request.content.replace(/\s+/g, " ").trim(); const content = normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 24))}… [summary truncated]`; return { content, sourceChars: request.content.length }; }
}

export class ModelContentReducer implements ContentReducer {
  constructor(private readonly model: ModelProvider) {}
  async reduce(request: ContentReductionRequest, context: ToolContext): Promise<ContentReductionResult> {
    const prompt = `Summarize the supplied ${request.source?.kind ?? "content"} faithfully. Preserve important facts, identifiers, APIs, constraints, errors, TODOs, and control-flow relationships. Do not invent conclusions. Keep the result under ${request.maxChars ?? 12000} characters.\n\nSOURCE:\n${request.content}`;
    let content = ""; for await (const event of this.model.generate({ schemaVersion: 1, requestId: `reduction-${context.executionId}`, input: prompt }, { ...context, executionId: `${context.executionId}:reduction` } as ModelContext)) { if (event.type === "delta") content += event.text; if (event.type === "tool-call") throw failure("MODEL_FAILED", "Content reduction model attempted a tool call."); }
    return { content, sourceChars: request.content.length };
  }
}
function inside(root: string, target: string): boolean { const path = relative(root, target); return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)); }
function selectRange(text: string, range?: { startLine?: number; endLine?: number }): { content: string; error?: import("./contracts.js").HarnessError } { if (!range) return { content: text }; const lines = text.split(/\r?\n/); const start = range.startLine ?? 1; const end = range.endLine ?? lines.length; if (start > end || start > lines.length) return { content: "", error: failure("VALIDATION_FAILED", "Line range is invalid.").error }; return { content: lines.slice(start - 1, Math.min(end, lines.length)).join("\n") }; }
function invalid(issues: unknown): ToolResult { return { ok: false, error: failure("VALIDATION_FAILED", "Filesystem arguments are invalid.", false, { issues }).error }; }
function unavailableMutation(): ToolResult { return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", "Filesystem mutation is disabled.").error }; }
