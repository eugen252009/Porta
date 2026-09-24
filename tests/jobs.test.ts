import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApplicationGateway, KernelEvent } from "../src/contracts.js";
import { JobRunner, MemoryJobStore, SqliteJobStore, jobTerminal } from "../src/jobs.js";
import { openSqlitePersistence } from "../src/persistence-sqlite.js";
import { sessionFromBase } from "../src/conversation.js";

async function wait(check: () => boolean) { for (let n = 0; n < 200; n++) { if (check()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error("Job did not reach expected state"); }
const input = { key: "receipt", nodeId: "local", sessionId: "session", input: "Build the fixture" };
const success: ApplicationGateway = { async *execute() { yield { type: "OutputDelta", text: "Result saved" }; yield { type: "ExecutionCompleted" }; } };

describe("server-owned jobs", () => {
  it("accepts once and executes serially without a subscriber", async () => {
    const store = new MemoryJobStore(); let calls = 0; let concurrency = 0; let maximum = 0;
    const gateway: ApplicationGateway = { async *execute() { calls++; maximum = Math.max(maximum, ++concurrency); await new Promise((r) => setTimeout(r, 10)); yield { type: "OutputDelta", text: "Completed output" }; concurrency--; yield { type: "ExecutionCompleted" }; } };
    const runner = new JobRunner(store, gateway);
    const first = runner.accept(input); expect(first.status).toBe("queued");
    expect(runner.accept(input).id).toBe(first.id);
    const second = runner.accept({ ...input, key: "second" });
    await wait(() => store.get(second.id)?.status === "completed");
    expect(calls).toBe(2); expect(maximum).toBe(1);
    expect(store.get(first.id)?.activity.some((event) => event.text === "Completed output")).toBe(true);
    expect(store.get(first.id)?.verification).toBe("not_recorded");
    await runner.stop();
  });

  it("retains failed output, provider errors, and exceptions", async () => {
    const store = new MemoryJobStore();
    const runner = new JobRunner(store, { async *execute() { yield { type: "OutputDelta", text: "Partial progress" }; throw new Error("Provider unavailable"); } });
    const job = runner.accept(input); await wait(() => store.get(job.id)?.status === "failed");
    expect(store.get(job.id)?.failure).toBe("Provider unavailable");
    expect(store.get(job.id)?.activity.some((item) => item.text === "Partial progress")).toBe(true);
    await runner.stop();
  });

  it("does not mark completion before the gateway commits its turn", async () => {
    const store = new MemoryJobStore();
    const runner = new JobRunner(store, { async *execute() { yield { type: "ExecutionCompleted" }; throw new Error("Commit failed"); } });
    const job = runner.accept(input); await wait(() => store.get(job.id)?.status === "failed");
    expect(store.get(job.id)?.failure).toBe("Commit failed"); await runner.stop();
  });

  it("shows approval waits and supports a bounded deadline", async () => {
    const store = new MemoryJobStore();
    const gateway: ApplicationGateway = { async *execute(_command, context) {
      yield { type: "ApprovalRequested", approvalId: "a", toolCallId: "c", toolId: "filesystem/write_file", input: {}, executionId: "e", sessionId: "session", traceId: "t" } as KernelEvent;
      await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "ExecutionCancelled" };
    } };
    const runner = new JobRunner(store, gateway, { timeoutMs: 80 }); const job = runner.accept(input);
    await wait(() => store.get(job.id)?.status === "needs_attention");
    await wait(() => store.get(job.id)?.status === "failed");
    expect(store.get(job.id)?.failure).toBe("Job deadline exceeded."); await runner.stop();
  });

  it("rejects malformed prompts and a full queue without starting extra work", async () => {
    const runner = new JobRunner(new MemoryJobStore(), success, { maxQueued: 1 });
    expect(() => runner.accept({ ...input, input: " " })).toThrow();
    expect(() => runner.accept({ ...input, input: "x".repeat(524289) })).toThrow();
    runner.accept(input); expect(() => runner.accept({ ...input, key: "overflow" })).toThrow("queue is full");
    await runner.stop();
  });

  it("persists receipts, recovers queued work, and never replays interrupted work", async () => {
    const root = await mkdtemp(join(tmpdir(), "porta-jobs-"));
    let db = await openSqlitePersistence(join(root, "state.db"));
    try {
      await db.conversations.createSession(sessionFromBase({ schemaVersion: 1, id: "session", state: "open", createdAt: new Date().toISOString() }));
      const store = new SqliteJobStore(db.database); const runner = new JobRunner(store, success);
      const queued = runner.accept(input); await runner.stop(); // stop before deferred worker starts
      const interrupted = { ...queued, id: "interrupted", key: "interrupted", status: "running" as const }; store.insert(interrupted);
      db.close(); db = await openSqlitePersistence(join(root, "state.db"));
      const restored = new SqliteJobStore(db.database); let calls = 0;
      const next = new JobRunner(restored, { async *execute() { calls++; yield { type: "ExecutionCompleted" }; } });
      next.start(); await wait(() => restored.get(queued.id)?.status === "completed");
      expect(restored.get("interrupted")?.status).toBe("interrupted"); expect(calls).toBe(1);
      expect(next.accept(input).id).toBe(queued.id);
      expect(restored.get(queued.id)?.input).toBe(input.input);
      await next.stop();
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("cancels queued jobs without executing them", async () => {
    let calls = 0; const store = new MemoryJobStore();
    const runner = new JobRunner(store, { async *execute() { calls++; yield { type: "ExecutionCompleted" }; } });
    const job = runner.accept(input); await runner.cancelSession(input.sessionId);
    await wait(() => jobTerminal(store.get(job.id)!.status)); expect(calls).toBe(0); await runner.stop();
  });
});
