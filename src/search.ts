import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { HarnessFailure, ToolContext } from "./contracts.js";

export interface SearchQuery { readonly query: string; readonly mode?: "text" | "regex"; readonly limit?: number; readonly maxExcerptChars?: number }
export interface SearchDocument { readonly id: string; readonly content: string }
export interface SearchMatch { readonly source: string; readonly location: string; readonly line: number; readonly excerpt: string }
export interface SearchResult { readonly engine: string; readonly matches: readonly SearchMatch[]; readonly truncated: boolean }
export interface SearchSource { readonly kind: string; readonly nativeRoot?: string; documents(context: ToolContext): Promise<readonly SearchDocument[]> }
export interface SearchEngine { readonly name: string; supports(source: SearchSource): boolean; available(source: SearchSource): boolean; search(source: SearchSource, query: SearchQuery, context: ToolContext): Promise<SearchResult> }

const defaultLimit = 20;
const defaultExcerpt = 240;

export class LinearTextSearchEngine implements SearchEngine {
  readonly name = "linear";
  supports(_source: SearchSource): boolean { return true; }
  available(_source: SearchSource): boolean { return true; }
  async search(source: SearchSource, query: SearchQuery, context: ToolContext): Promise<SearchResult> {
    const limit = positive(query.limit, defaultLimit); const maxExcerpt = positive(query.maxExcerptChars, defaultExcerpt); const matcher = makeMatcher(query); const matches: SearchMatch[] = []; let truncated = false;
    for (const document of await source.documents(context)) { if (context.signal.aborted) throw new HarnessFailure({ code: "CANCELLED", message: "Search was cancelled.", retryable: false }); const lines = document.content.split(/\r?\n/); for (let index = 0; index < lines.length; index++) { if (!matcher(lines[index]!)) continue; if (matches.length >= limit) { truncated = true; break; } matches.push({ source: source.kind, location: document.id, line: index + 1, excerpt: clip(lines[index]!, maxExcerpt) }); } if (truncated) break; }
    return { engine: this.name, matches, truncated };
  }
}

export class RipgrepSearchEngine implements SearchEngine {
  readonly name = "ripgrep";
  supports(source: SearchSource): boolean { return Boolean(source.nativeRoot); }
  available(_source: SearchSource): boolean { return commandAvailable("rg"); }
  async search(source: SearchSource, query: SearchQuery, context: ToolContext): Promise<SearchResult> { return externalSearch(this.name, "rg", source, query, context, ["--line-number", "--with-filename", "--no-heading", "--color", "never", ...(query.mode === "text" ? ["--fixed-strings"] : [])]); }
}

export class GrepSearchEngine implements SearchEngine {
  readonly name = "grep";
  supports(source: SearchSource): boolean { return Boolean(source.nativeRoot); }
  available(_source: SearchSource): boolean { return commandAvailable("grep"); }
  async search(source: SearchSource, query: SearchQuery, context: ToolContext): Promise<SearchResult> { return externalSearch(this.name, "grep", source, query, context, ["-r", "-n", "-H", "--binary-files=without-match", ...(query.mode === "text" ? ["-F"] : ["-E"])]); }
}

export class CCCSearchEngine implements SearchEngine {
  readonly name = "ccc";
  supports(source: SearchSource): boolean { return Boolean(source.nativeRoot); }
  available(source: SearchSource): boolean { return commandAvailable("ccc") && Boolean(source.nativeRoot && existsSync(join(source.nativeRoot, ".cocoindex_code", "target_sqlite.db"))); }
  async search(source: SearchSource, query: SearchQuery, context: ToolContext): Promise<SearchResult> {
    if (!source.nativeRoot) throw new HarnessFailure({ code: "CAPABILITY_UNAVAILABLE", message: "CCC requires a filesystem search source.", retryable: false });
    const limit = positive(query.limit, defaultLimit); const result = await runProcess("ccc", ["search", "--json", "--limit", String(limit), query.query], source.nativeRoot, context); if (result.code !== 0) throw new HarnessFailure({ code: "TOOL_FAILED", message: "CCC search failed.", retryable: false });
    try { const parsed = JSON.parse(result.stdout) as { results?: readonly { file_path: string; start_line?: number; content?: string }[]; total_returned?: number }; const matches = (parsed.results ?? []).filter((item) => within(source.nativeRoot!, item.file_path)).slice(0, limit).map((item) => ({ source: source.kind, location: relative(source.nativeRoot!, resolve(source.nativeRoot!, item.file_path)), line: item.start_line ?? 1, excerpt: clip(item.content ?? "", query.maxExcerptChars ?? defaultExcerpt) })); return { engine: this.name, matches, truncated: (parsed.total_returned ?? matches.length) > matches.length }; } catch { throw new HarnessFailure({ code: "TOOL_FAILED", message: "CCC returned an invalid search response.", retryable: false }); }
  }
}

export function selectSearchEngine(source: SearchSource, candidates: readonly SearchEngine[]): SearchEngine | undefined { return candidates.find((engine) => engine.supports(source) && engine.available(source)); }

async function externalSearch(name: string, command: string, source: SearchSource, query: SearchQuery, context: ToolContext, flags: readonly string[]): Promise<SearchResult> {
  if (!source.nativeRoot) throw new HarnessFailure({ code: "CAPABILITY_UNAVAILABLE", message: `${name} requires a filesystem search source.`, retryable: false });
  const limit = positive(query.limit, defaultLimit); const result = await runProcess(command, [...flags, "--", query.query, source.nativeRoot], source.nativeRoot, context); if (result.code === 1) return { engine: name, matches: [], truncated: false }; if (result.code !== 0) throw new HarnessFailure({ code: "TOOL_FAILED", message: `${name} search failed.`, retryable: false });
  const allMatches: SearchMatch[] = []; for (const line of result.stdout.split(/\r?\n/)) { if (!line) continue; const match = /^(.*?):(\d+):(.*)$/.exec(line); if (!match) continue; allMatches.push({ source: source.kind, location: relative(source.nativeRoot, match[1]!), line: Number(match[2]), excerpt: clip(match[3]!, query.maxExcerptChars ?? defaultExcerpt) }); }
  allMatches.sort((left, right) => left.location.localeCompare(right.location) || left.line - right.line);
  return { engine: name, matches: allMatches.slice(0, limit), truncated: allMatches.length > limit };
}

async function runProcess(command: string, args: readonly string[], cwd: string, context: ToolContext): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => { const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk.toString(); if (stdout.length > 2_000_000) child.kill("SIGTERM"); }); const abort = () => child.kill("SIGTERM"); const timer = context.deadline === undefined ? undefined : setTimeout(abort, Math.max(0, context.deadline - Date.now())); if (context.signal.aborted) abort(); else context.signal.addEventListener("abort", abort, { once: true }); child.on("error", reject); child.on("close", (code) => { if (timer) clearTimeout(timer); context.signal.removeEventListener("abort", abort); if (context.signal.aborted) reject(new HarnessFailure({ code: "CANCELLED", message: "Search was cancelled.", retryable: false })); else if (context.deadline !== undefined && Date.now() >= context.deadline) reject(new HarnessFailure({ code: "TIMEOUT", message: "Search exceeded its deadline.", retryable: true })); else resolve({ code: code ?? 1, stdout }); }); });
}
function commandAvailable(command: string): boolean { try { execFileSync("which", [command], { stdio: "ignore" }); return true; } catch { return false; } }
function makeMatcher(query: SearchQuery): (line: string) => boolean { if (!query.query) throw new HarnessFailure({ code: "VALIDATION_FAILED", message: "Search query cannot be empty.", retryable: false }); if (query.mode === "regex") { try { const regex = new RegExp(query.query); return (line) => regex.test(line); } catch { throw new HarnessFailure({ code: "VALIDATION_FAILED", message: "Search regular expression is invalid.", retryable: false }); } } return (line) => line.includes(query.query); }
function positive(value: number | undefined, fallback: number): number { return value === undefined ? fallback : Math.max(1, Math.min(1000, Math.floor(value))); }
function within(root: string, candidate: string): boolean { const target = resolve(root, candidate); const path = relative(root, target); return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)); }
function clip(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`; }
