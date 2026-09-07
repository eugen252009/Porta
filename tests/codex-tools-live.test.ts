import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadPortaConfig } from "../src/porta-config.js";
import { createPortaApplication } from "../src/porta-application.js";
import type { KernelEvent } from "../src/contracts.js";

const live = process.env.RUN_CODEX_TOOL_INTEGRATION_TESTS === "1" ? describe : describe.skip;
live("real Codex subscription filesystem qualification (explicit opt-in)", () => {
  it("creates and reads a file through Porta tools, not merely an assistant claim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "porta-codex-live-"));
    const root = join(directory, "workspace"); await mkdir(root);
    const file = join(directory, "porta.json");
    await writeFile(file, JSON.stringify({ model: { provider: "openai-codex", model: process.env.PORTA_MODEL ?? "gpt-5.6-sol" }, filesystem: { root, mutation: { enabled: true } }, authorization: { mode: "require-approval" }, agent: { maxSteps: 6, maxToolCalls: 6 } }));
    let app: Awaited<ReturnType<typeof createPortaApplication>> | undefined;
    try {
      const config = await loadPortaConfig(file);
      app = await createPortaApplication(config); await app.start();
      let sessionId = "";
      for await (const event of app.gateway.execute({ type: "CreateSession" })) if (event.type === "SessionCreated") sessionId = event.sessionId;
      const completed: Extract<KernelEvent, { type: "ToolCompleted" }>[] = [];
      const errors: string[] = [];
      const approvals: { toolId: string; approved: boolean; mode?: string; pathMatches: boolean; contentMatches: boolean }[] = [];
      const context = { signal: AbortSignal.timeout(120000) };
      for await (const event of app.gateway.execute({ type: "SubmitInput", sessionId, input: "Create a file named porta-live.txt containing PORTA_TOOL_OK. Read the file back and reply only with its contents." }, context)) {
        if (event.type === "ApprovalRequested") {
          const parsed = z.object({ path: z.string(), mode: z.string().optional(), content: z.string().optional() }).safeParse(event.input);
          const fields = parsed.success ? parsed.data : undefined;
          const allowed = fields?.path === "porta-live.txt" && (
            event.toolId === "filesystem/write_file" && fields.mode === "create" && fields.content === "PORTA_TOOL_OK" ||
            event.toolId === "filesystem/read_file" && (fields.mode === undefined || fields.mode === "exact")
          );
          approvals.push({ toolId: event.toolId, approved: allowed, mode: fields?.mode, pathMatches: fields?.path === "porta-live.txt", contentMatches: fields?.content === "PORTA_TOOL_OK" });
          for await (const _approval of app.gateway.execute({ type: "ResolveApproval", approvalId: event.approvalId, decision: allowed ? "approve" : "deny" })) { /* only the requested file operation is approved */ }
        }
        if (event.type === "ToolCompleted") completed.push(event);
        if (event.type === "Error") errors.push(`${event.error.code}: ${event.error.message}`);
        if (event.type === "ExecutionCancelled") errors.push("Execution cancelled");
      }
      console.info(JSON.stringify({ approvals, completed: completed.map((event) => ({ toolId: event.toolId, error: event.result.error?.code })) }));
      expect(errors).toEqual([]);
      const write = completed.find((event) => event.toolId === "filesystem/write_file");
      const read = completed.find((event) => event.toolId === "filesystem/read_file");
      expect(write?.result.error).toBeUndefined(); expect(write?.result.output).toMatchObject({ path: "porta-live.txt" });
      expect(read?.result.error).toBeUndefined(); expect(read?.result.output).toMatchObject({ path: "porta-live.txt", mode: "exact", content: "PORTA_TOOL_OK" });
      expect(completed.indexOf(write!)).toBeLessThan(completed.indexOf(read!));
      expect(await readFile(join(root, "porta-live.txt"), "utf8")).toBe("PORTA_TOOL_OK");
      const last = (await app.conversations.snapshot(sessionId)).history.at(-1);
      expect(last).toMatchObject({ role: "assistant", content: "PORTA_TOOL_OK" });
      // Safe evidence only: no HTTP payloads/headers or credential contents.
      console.info(JSON.stringify({ model: config.model.model, tools: app.toolRouter.listTools().length, completed: completed.map((event) => event.toolId), fileVerified: true, toolReadVerified: true, finalReply: "PORTA_TOOL_OK", fixtureRemovedAfterTest: true }));
    } finally { await app?.shutdown(); await rm(directory, { recursive: true, force: true }); }
  }, 150000);
});
