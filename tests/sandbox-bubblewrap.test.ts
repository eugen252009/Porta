import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BubblewrapSandbox } from "../src/adapters/sandbox-bubblewrap.js";
import { HostProcessRuntime } from "../src/adapters/runtime-host-process.js";
import { ExecutionToolProvider } from "../src/execution.js";

describe("optional bubblewrap qualification", () => {
  it("denies a controlled loopback connection when the backend is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "porta-bwrap-")); const sandbox = new BubblewrapSandbox({ workspaceRoot: root }); if (!(await sandbox.available())) return;
    const listener = createServer().listen(0, "127.0.0.1"); await new Promise<void>((resolve) => listener.once("listening", () => resolve())); const address = listener.address(); if (!address || typeof address === "string") { listener.close(); return; }
    const tool = new ExecutionToolProvider(new HostProcessRuntime(), sandbox, { workspaceRoot: root, allowedCommands: ["node"], defaultTimeoutMs: 2000, maxStdoutBytes: 1024, maxStderrBytes: 1024, policy: { filesystem: "best-effort", network: "deny", codeLoading: "best-effort" } });
    const input = { command: "node", args: ["-e", `const net=require('node:net'); const s=net.connect(${address.port},'127.0.0.1',()=>process.exit(1)); s.on('error',()=>process.exit(0)); setTimeout(()=>process.exit(0),500);`] };
    const result = await tool.invoke({ schemaVersion: 1, requestId: "network", toolId: "run", input }, { traceId: "t", sessionId: "s", executionId: "e", signal: new AbortController().signal }); listener.close(); expect(result).toMatchObject({ ok: true, output: { exitCode: 0, sandbox: { enforcement: { network: "external" } } } });
  }, 10000);
});
