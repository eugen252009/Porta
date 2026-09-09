import { describe, expect, it } from "vitest";
import { capturePersistenceTaskSnapshot, comparePersistenceTaskSnapshots } from "../src/task-persistence-qualification.js";
import type { Task } from "../src/task.js";

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1", sessionId: "session-1", objective: "Persistence qualification probe.", constraints: [], status: "active", steps: [], criteria: [], evidence: [], version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides,
});

describe("task persistence qualification snapshots", () => {
  it("sorts IDs and produces stable identity and durable hashes", () => {
    const first = capturePersistenceTaskSnapshot([task(), { ...task({ id: "task-2", sessionId: "session-2", objective: "Second." }) }], "before");
    const second = capturePersistenceTaskSnapshot([{ ...task({ id: "task-2", sessionId: "session-2", objective: "Second.", updatedAt: "later" }) }, task({ updatedAt: "also later" })], "after");
    expect(first.taskIds).toEqual(["task-1", "task-2"]);
    expect(first.identityHash).toBe(second.identityHash);
    expect(first.durableStateHash).toBe(second.durableStateHash);
  });

  it("detects missing and durable changes while excluding updatedAt", () => {
    const before = capturePersistenceTaskSnapshot([task(), task({ id: "task-2", sessionId: "session-2", objective: "Second." })]);
    const after = capturePersistenceTaskSnapshot([task({ objective: "Changed." })]);
    const comparison = comparePersistenceTaskSnapshots(before, after);
    expect(comparison.missingTaskIds).toEqual(["task-2"]);
    expect(comparison.unexpectedDifferences.map((entry) => entry.taskId)).toEqual(["task-1"]);
    expect(comparison.pass).toBe(false);
  });

  it("accepts explicitly declared recovery transitions only", () => {
    const before = capturePersistenceTaskSnapshot([task({ status: "active" })]);
    const after = capturePersistenceTaskSnapshot([task({ status: "failed", failureReason: "restart" })]);
    const rejected = comparePersistenceTaskSnapshots(before, after);
    const accepted = comparePersistenceTaskSnapshots(before, after, (left, right) => left.status === "active" && right.status === "failed");
    expect(rejected.pass).toBe(false);
    expect(accepted.allowedRecoveryTransitions).toEqual(["task-1"]);
    expect(accepted.pass).toBe(true);
  });
});
