import { describe, expect, it } from "vitest";
import { DelegatedTaskStore, effectivePermissions } from "../src/delegation.js";
import { MemoryScratchpadStore } from "../src/scratchpad.js";
import { openSqlitePersistence } from "../src/persistence-sqlite.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegationOrchestrator } from "../src/delegation.js";
import { MockModelProvider } from "../src/adapters.js";
import { ToolRouter } from "../src/tools.js";
import { AllowAllToolAuthorizationPolicy } from "../src/authorization-mocks.js";

const model = (id: string) => ({ id, version: "1", capabilities: [] });

describe("bounded delegated tasks", () => {
  it("inherits only a restricted snapshot of parent permissions", async () => {
    const scratchpad = new MemoryScratchpadStore();
    const store = new DelegatedTaskStore(scratchpad, { maxDepth: 2, maxChildren: 2 });
    const task = await store.create("parent", ["filesystem.read", "filesystem.write", "execution", "agent.delegate"], { objective: "investigate", restrict: ["filesystem.write", "execution", "agent.delegate"], scratchpad: { hypotheses: ["The validation path may be involved."], relevantFiles: ["src/model-picker.ts"] } });
    expect(task.effectivePermissions).toEqual(["filesystem.read"]);
    const notes = await store.snapshot(task.id);
    expect(notes.scratchpad[0]?.content).toContain("[tentative]");
    expect(effectivePermissions(["filesystem.read"], ["execution"])).toEqual(["filesystem.read"]);
  });

  it("retains task scratchpad and permissions across model escalation", async () => {
    const store = new DelegatedTaskStore(new MemoryScratchpadStore());
    const task = await store.create("parent", ["filesystem.read", "agent.delegate"], { objective: "find the cause" });
    const first = await store.startAttempt(task.id, model("luna"));
    await store.appendFinding(task.id, "findings", "Inspected session ownership.");
    await store.finishAttempt(task.id, first.id, "insufficient-confidence", { summary: "Need a stronger review.", confidence: "low" });
    const second = await store.startAttempt(task.id, model("sol"));
    const snapshot = await store.snapshot(task.id);
    expect(second.model.id).toBe("sol");
    expect(second.permissions).toEqual(["filesystem.read", "agent.delegate"]);
    expect(snapshot.task.id).toBe(task.id);
    expect(snapshot.scratchpad.find((entry) => entry.key === "findings")?.content).toContain("Inspected session ownership.");
  });

  it("enforces recursion and child-count bounds", async () => {
    const store = new DelegatedTaskStore(new MemoryScratchpadStore(), { maxDepth: 1, maxChildren: 1 });
    const task = await store.create("parent", ["agent.delegate"], { objective: "one" });
    await expect(store.create("parent", ["agent.delegate"], { objective: "two" })).rejects.toThrow("child limit");
    await expect(store.create(task.id, ["agent.delegate"], { objective: "nested" }, 1)).rejects.toThrow("depth limit");
    await expect(store.create("parent", [], { objective: "denied" })).rejects.toThrow("agent.delegate");
  });

  it("runs a child through the normal AgentExecution stack", async () => {
    const store = new DelegatedTaskStore(new MemoryScratchpadStore());
    const task = await store.create("parent", ["agent.delegate"], { objective: "say hello" });
    const execution = new DelegationOrchestrator(store);
    const result = await execution.runAttempt({ taskId: task.id, model: new MockModelProvider("child result"), tools: new ToolRouter(), policy: new AllowAllToolAuthorizationPolicy() });
    expect(result.task.status).toBe("completed");
    expect(result.result?.summary).toContain("child result");
    expect(result.attempt.model.id).toBe("mock");
  });

  it("persists task, attempts, and scratchpad across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "porta-delegation-db-"));
    const firstPersistence = await openSqlitePersistence(join(root, "state.db"));
    await firstPersistence.conversations.createSession({ schemaVersion: 1, id: "parent", state: "open", createdAt: new Date().toISOString(), history: [], turns: [] });
    const first = new DelegatedTaskStore(firstPersistence.scratchpad, { maxDepth: 2, maxChildren: 2 }, firstPersistence.delegations);
    const task = await first.create("parent", ["filesystem.read", "agent.delegate"], { objective: "persist", scratchpad: { context: ["start here"] } });
    const attempt = await first.startAttempt(task.id, model("luna"));
    await first.appendFinding(task.id, "findings", "durable finding");
    await first.finishAttempt(task.id, attempt.id, "insufficient-confidence", { summary: "needs escalation", confidence: "low" });
    firstPersistence.close();
    const secondPersistence = await openSqlitePersistence(join(root, "state.db"));
    const second = new DelegatedTaskStore(secondPersistence.scratchpad, { maxDepth: 2, maxChildren: 2 }, secondPersistence.delegations);
    await second.restore(await secondPersistence.delegations.load());
    const restored = await second.snapshot(task.id);
    expect(restored.task.status).toBe("insufficient-confidence");
    expect(restored.task.attempts[0]?.model.id).toBe("luna");
    expect(restored.scratchpad.find((entry) => entry.key === "findings")?.content).toContain("durable finding");
    secondPersistence.close();
  });

  it("cancels a delegated task without changing its permission snapshot", async () => {
    const store = new DelegatedTaskStore(new MemoryScratchpadStore());
    const task = await store.create("parent", ["filesystem.read", "agent.delegate"], { objective: "stop" });
    const cancelled = store.cancel(task.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.effectivePermissions).toEqual(["filesystem.read", "agent.delegate"]);
  });
});
