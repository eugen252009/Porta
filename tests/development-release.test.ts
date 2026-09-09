import { describe, expect, it } from "vitest";
import { DevelopmentRunner, DevelopmentPhaseDriver, DevelopmentReleaseCapabilities } from "../src/development-runner.js";
import { MemoryTaskStore } from "../src/task.js";

const base = { goal: "release fixture", acceptanceCriteria: ["fixture works"], workspace: { path: "/tmp/fixture" }, permissions: { mutate: false, commit: true, push: true, deploy: true }, focusedCommands: ["focused"], fullCommands: ["full"], phase: "ready_for_commit" as const, acceptance: [{ id: "ac-1", description: "fixture works", status: "pass" as const, evidence: "tests" }], originalRevision: "base", executionRecords: [{ id: "verify", category: "verification" as const, command: "full", startedAt: "now", finishedAt: "now", status: "passed" as const }], updatedAt: "now" };

describe("development release orchestration", () => {
  it("persists each release boundary and recovers without repeating deployment", async () => {
    const tasks = new MemoryTaskStore(); await tasks.create("release-session", "release fixture", [], base);
    const calls: string[] = []; let qualified = false;
    const release: DevelopmentReleaseCapabilities = { async commit() { calls.push("commit"); return { revision: "commit-1", subject: "release" }; }, async push(input) { calls.push(`push:${input.revision}`); return { revision: input.revision, branch: "main" }; }, async build(input) { calls.push(`build:${input.revision}`); return { reference: "192.168.188.2:9006/porta:commit-1", repository: "192.168.188.2:9006/porta", tag: "commit-1", sourceRevision: input.revision }; }, async pushImage(input) { calls.push(`image:${input.sourceRevision}`); return { ...input, repository: "192.168.188.2:9006/porta", tag: "commit-1", sourceRevision: input.sourceRevision, reference: input.reference, latestReference: "192.168.188.2:9006/porta:latest" }; }, async deploy() { calls.push("deploy"); return { status: "triggered" }; }, async qualify() { calls.push("qualify"); qualified = true; return { ready: qualified, correctRevision: true, taskStateAvailable: true }; } };
    const driver: DevelopmentPhaseDriver = { async run() { return { type: "advance", phase: "ready_for_commit" }; } };
    const runner = new DevelopmentRunner(tasks, driver, { release }); const handoff = await runner.release("release-session"); expect(handoff.development?.phase).toBe("health_checking"); expect(handoff.development?.deployment?.status).toBe("awaiting_recovery"); expect(calls).toEqual(["commit", "push:commit-1", "build:commit-1", "image:commit-1", "deploy"]);
    const recovered = await runner.recover("release-session"); expect(recovered.status).toBe("completed"); expect(recovered.development?.deployment?.status).toBe("succeeded"); expect(calls.at(-1)).toBe("qualify");
    await runner.recover("release-session"); expect(calls.filter((call) => call === "deploy")).toHaveLength(1);
  });
});
