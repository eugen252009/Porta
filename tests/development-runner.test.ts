import { describe, expect, it } from "vitest";
import { DevelopmentRunner, DevelopmentPhaseDriver } from "../src/development-runner.js";
import { MemoryTaskStore } from "../src/task.js";

const state = { goal: "fix fixture", acceptanceCriteria: ["tests pass"], workspace: { path: "/tmp/fixture" }, permissions: { mutate: true, commit: false, push: false, deploy: false }, focusedCommands: ["npm test"], fullCommands: ["npm test", "npm run typecheck"], phase: "queued" as const, updatedAt: "2024-01-01T00:00:00.000Z" };

describe("persistent development runner", () => {
  it("pauses for approval and resumes the same task after runner recreation", async () => {
    const tasks = new MemoryTaskStore();
    await tasks.create("session-a", "fix fixture", [], state);
    let blocked = true;
    const driver: DevelopmentPhaseDriver = { async run({ state: current }) { if (blocked) return { type: "attention", reason: "approval_required", message: "Approve the mutation.", action: "approve" }; if (current.phase === "queued") return { type: "advance", phase: "implementing", event: "Inspected fixture." }; if (current.phase === "implementing") return { type: "advance", phase: "verifying_focused", event: "Applied bounded change." }; if (current.phase === "verifying_focused") return { type: "advance", phase: "verifying_full", event: "Focused verification passed." }; if (current.phase === "verifying_full") return { type: "advance", phase: "reviewing_diff", event: "Full verification passed." }; return { type: "advance", phase: "ready_for_commit", patch: { acceptance: [{ id: "ac-1", description: "tests pass", status: "pass", evidence: "fixture verification" }] }, event: "Diff reviewed." }; } };
    const first = new DevelopmentRunner(tasks, driver, { now: () => "2024-01-01T00:00:01.000Z" });
    let task = await first.wake("session-a");
    expect(task?.development?.attention?.reason).toBe("approval_required");
    const stale = await first.intervene("session-a", task!.version - 1, "approve").catch((error) => error);
    expect(stale.error.code).toBe("CAPABILITY_CONFLICT");
    task = await first.intervene("session-a", task!.version, "approve");
    blocked = false;
    const second = new DevelopmentRunner(tasks, driver, { now: () => "2024-01-01T00:00:02.000Z" });
    task = await second.wake("session-a");
    expect(task?.id).toBe((await tasks.get("session-a"))?.id);
    expect(task?.development?.phase).toBe("ready_for_commit");
    expect(task?.development?.acceptance?.[0]?.status).toBe("pass");
    expect(task?.development?.executionRecords?.at(-1)?.status).toBe("passed");
    expect(task?.development?.attention).toBeUndefined();
  });

  it("does not repeat a phase after a restart finds an in-flight marker", async () => {
    const tasks = new MemoryTaskStore();
    await tasks.create("session-b", "interrupted", [], { ...state, phase: "implementing" });
    let task = await tasks.get("session-b");
    task = await tasks.update("session-b", task!.id, task!.version, { type: "set_development", development: { ...task!.development!, execution: { phase: "implementing", status: "running", attempt: 1, startedAt: "2024-01-01T00:00:00.000Z" }, updatedAt: "2024-01-01T00:00:00.000Z" } });
    let calls = 0;
    const runner = new DevelopmentRunner(tasks, { async run() { calls++; return { type: "advance", phase: "verifying_focused" }; } });
    const recovered = await runner.wake("session-b");
    expect(calls).toBe(0);
    expect(recovered?.development?.attention?.reason).toBe("execution_failed");
    expect(recovered?.development?.pendingIntervention?.action).toBe("resume");
  });
});
