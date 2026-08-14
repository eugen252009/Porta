import { describe, expect, it } from "vitest";
import { ArtifactToolProvider, MemoryArtifactStore, sha256, ArtifactStore } from "../src/artifact.js";
import { LinearTextSearchEngine } from "../src/search.js";
import { ToolContext, ToolInvocation } from "../src/contracts.js";
import { ExecutionToolProvider } from "../src/execution.js";
import { HostProcessLauncher, HostProcessRuntime } from "../src/adapters/runtime-host-process.js";
import { HostProcessSandbox } from "../src/adapters/sandbox-host-process.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const context = (sessionId = "artifact-session"): ToolContext => ({ traceId: "t", sessionId, executionId: "e", signal: new AbortController().signal });
const call = (toolId: string, input: unknown): ToolInvocation => ({ schemaVersion: 1, requestId: toolId, toolId, input: input as never });

describe("artifact store", () => {
  it("stores immutable session-scoped exact content with integrity metadata", async () => { const store = new MemoryArtifactStore(); const ref = await store.put("a", { kind: "log", contentType: "text/plain", content: "alpha\nSENTINEL\n", source: "test" }); expect(ref.uri.startsWith("artifact://")).toBe(true); expect(ref.sha256).toBe(sha256(new TextEncoder().encode("alpha\nSENTINEL\n"))); expect((await store.get("a", ref.uri))?.content).toBe("alpha\nSENTINEL\n"); expect(await store.get("b", ref.artifactId)).toBeUndefined(); });
  it("reads bounded content and searches excerpts explicitly", async () => { const store = new MemoryArtifactStore(); const ref = await store.put("artifact-session", { kind: "report", contentType: "text/plain", content: "first\nEXACT_ARTIFACT_SENTINEL_991\nlast", source: "test" }); const provider = new ArtifactToolProvider(store, new LinearTextSearchEngine(), 100); expect(await provider.invoke(call("stat", { artifactId: ref.uri }), context())).toMatchObject({ ok: true, output: { sha256: ref.sha256 } }); expect(await provider.invoke(call("read", { artifactId: ref.uri, startLine: 2, endLine: 2 }), context())).toMatchObject({ ok: true, output: { content: "EXACT_ARTIFACT_SENTINEL_991", exact: true } }); expect(await provider.invoke(call("search", { query: "SENTINEL" }), context())).toMatchObject({ ok: true, output: { matches: [{ location: ref.artifactId }] } }); });
  it("retains oversized execution output exactly once", async () => { let launches = 0; const process = { stdin: { end() {} }, stdout: (async function* () { yield Buffer.from("prefix\nFULL_EXECUTION_SENTINEL_8271\nsuffix"); })(), stderr: (async function* () {})(), exited: Promise.resolve({ code: 0 }), kill() {} }; const launcher: HostProcessLauncher = () => { launches++; return process; }; const artifacts = new MemoryArtifactStore(); const root = mkdtempSync(join(tmpdir(), "porta-artifact-exec-")); const provider = new ExecutionToolProvider(new HostProcessRuntime(launcher), new HostProcessSandbox(), { workspaceRoot: root, allowedCommands: ["node"], defaultTimeoutMs: 1000, maxStdoutBytes: 8, maxStderrBytes: 8, artifactStore: artifacts, maxArtifactBytes: 1024, policy: { filesystem: "best-effort", network: "best-effort", codeLoading: "best-effort" } }); const result = await provider.invoke(call("run", { command: "node" }), context()); expect(launches).toBe(1); expect(result).toMatchObject({ ok: true, output: { stdoutTruncated: true } }); const output = (result as unknown as { output: { stdoutArtifact: { artifactId: string } } }).output; const stored = await artifacts.get("artifact-session", output.stdoutArtifact.artifactId); expect(stored?.content).toBe("prefix\nFULL_EXECUTION_SENTINEL_8271\nsuffix"); });
});
