import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { JsonValue, ToolContext, failure } from "./contracts.js";
import { WorkspaceBoundary } from "./workspace.js";

export interface MutationWriteRequest { path: string; content: string; mode: "create" | "replace" | "create-or-replace"; expectedHash?: string }
export interface MutationPatchEdit { oldText: string; newText: string; expectedOccurrences?: number }
export interface MutationPatchRequest { path: string; edits: readonly MutationPatchEdit[]; expectedHash?: string }
export interface MutationResult { path: string; operation: "write" | "patch"; changed: boolean; beforeHash?: string; afterHash: string; bytesBefore: number; bytesAfter: number; verified: boolean }
export interface MutationEngine { write(request: MutationWriteRequest, context: ToolContext): Promise<MutationResult>; patch(request: MutationPatchRequest, context: ToolContext): Promise<MutationResult> }
export interface MutationLimits { maxWriteBytes: number; maxPatchTargetBytes: number }

export class DirectFilesystemMutationEngine implements MutationEngine {
  constructor(private readonly boundary: WorkspaceBoundary, private readonly limits: MutationLimits = { maxWriteBytes: 2 * 1024 * 1024, maxPatchTargetBytes: 8 * 1024 * 1024 }) {}
  async write(request: MutationWriteRequest, context: ToolContext): Promise<MutationResult> {
    this.check(context); const target = await this.boundary.resolveMutation(request.path); if (request.mode === "create" && target.exists) throw failure("CAPABILITY_CONFLICT", "File already exists; create mode will not overwrite it."); if (request.mode === "replace" && !target.exists) throw failure("CAPABILITY_UNAVAILABLE", "File does not exist; replace mode will not create it.");
    const contentBytes = Buffer.byteLength(request.content); if (contentBytes > this.limits.maxWriteBytes) throw failure("TOOL_FAILED", `Write exceeds the maximum size of ${this.limits.maxWriteBytes} bytes.`); const before = target.exists ? await this.readText(target.path, this.limits.maxWriteBytes) : undefined; this.checkHash(before?.buffer, request.expectedHash); if (before && before.text.includes("\0")) throw failure("TOOL_FAILED", "Binary files are not supported by filesystem mutation.");
    const result = await this.commit(target.path, request.content, "write", before?.buffer, context); return { ...result, path: request.path };
  }
  async patch(request: MutationPatchRequest, context: ToolContext): Promise<MutationResult> {
    this.check(context); const target = await this.boundary.resolveMutation(request.path); if (!target.exists) throw failure("CAPABILITY_UNAVAILABLE", "Patch target does not exist."); const before = await this.readText(target.path, this.limits.maxPatchTargetBytes); if (before.text.includes("\0")) throw failure("TOOL_FAILED", "Binary files are not supported by filesystem mutation."); this.checkHash(before.buffer, request.expectedHash); if (!request.edits.length) throw failure("VALIDATION_FAILED", "Patch must contain at least one edit.");
    let content = before.text; for (const edit of request.edits) { if (!edit.oldText) throw failure("VALIDATION_FAILED", "Patch oldText cannot be empty."); const occurrences = count(content, edit.oldText); const expected = edit.expectedOccurrences ?? 1; if (expected < 1 || occurrences !== expected) throw failure("VALIDATION_FAILED", `Patch context matched ${occurrences} times; expected ${expected}.`); content = content.replace(edit.oldText, edit.newText); }
    if (Buffer.byteLength(content) > this.limits.maxWriteBytes) throw failure("TOOL_FAILED", `Patched content exceeds the maximum size of ${this.limits.maxWriteBytes} bytes.`); const result = await this.commit(target.path, content, "patch", before.buffer, context); return { ...result, path: request.path };
  }
  private async commit(path: string, content: string, operation: "write" | "patch", before: Buffer | undefined, context: ToolContext): Promise<MutationResult> {
    this.check(context); const temporary = join(dirname(path), `.porta-mutation-${randomUUID()}.tmp`); try { await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" }); this.check(context); await fs.rename(temporary, path); } catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); if (error instanceof Error && "error" in error) throw error; throw failure(context.signal.aborted ? "CANCELLED" : "TOOL_FAILED", context.signal.aborted ? "Mutation was cancelled before commit." : "Filesystem mutation could not be committed."); }
    const after = await fs.readFile(path); const afterHash = hash(after); if (afterHash !== hash(Buffer.from(content, "utf8"))) throw failure("TOOL_FAILED", "Mutation committed but post-write verification failed."); return { path: path, operation, changed: !before || !before.equals(after), ...(before ? { beforeHash: hash(before) } : {}), afterHash, bytesBefore: before?.byteLength ?? 0, bytesAfter: after.byteLength, verified: true };
  }
  private async readText(path: string, maxBytes: number): Promise<{ buffer: Buffer; text: string }> { const buffer = await fs.readFile(path); if (buffer.byteLength > maxBytes) throw failure("TOOL_FAILED", `Mutation target exceeds the maximum size of ${maxBytes} bytes.`); return { buffer, text: buffer.toString("utf8") }; }
  private checkHash(buffer: Buffer | undefined, expected?: string) { if (expected && (!buffer || hash(buffer) !== expected)) throw failure("CAPABILITY_CONFLICT", "File changed since it was inspected; expected hash does not match."); }
  private check(context: ToolContext) { if (context.signal.aborted) throw failure("CANCELLED", "Filesystem mutation was cancelled before commit."); if (context.deadline !== undefined && Date.now() >= context.deadline) throw failure("TIMEOUT", "Filesystem mutation deadline was exceeded.", true); }
}
export function contentHash(content: Uint8Array): string { return hash(Buffer.from(content)); }
function hash(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function count(content: string, needle: string): number { let total = 0; let offset = 0; while ((offset = content.indexOf(needle, offset)) !== -1) { total++; offset += needle.length; } return total; }
