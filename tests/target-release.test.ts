import { describe, expect, it } from "vitest";
import { DevelopmentRunner } from "../src/development-runner.js";
import { MemoryTaskStore } from "../src/task.js";
import { TargetRegistry } from "../src/target.js";
import type { DevelopmentReleaseCapabilities } from "../src/development-runner.js";

const base = {
  goal: "release target fixture", acceptanceCriteria: ["verified"], acceptance: [{ id: "ac-1", description: "verified", status: "pass" as const }],
  developmentTargetId: "pc-test", workspace: { id: "pc-workspace", path: "/pc/workspace" }, permissions: { mutate: true, commit: true, push: true, deploy: true }, focusedCommands: [], fullCommands: [], phase: "ready_for_commit" as const, originalRevision: "base", executionRecords: [{ id: "verify", category: "verification" as const, command: "fixture", startedAt: "before", finishedAt: "after", status: "passed" as const }], updatedAt: "now",
};

describe("target-aware release", () => {
  it("runs commit, push, build and image push on the development target", async () => {
    const calls: string[] = [];
    const targetRelease: DevelopmentReleaseCapabilities = {
      async commit() { calls.push("target.commit"); return { revision: "target-commit", subject: "fixture" }; },
      async push() { calls.push("target.push"); return { revision: "target-commit", branch: "main" }; },
      async build() { calls.push("target.build"); return { reference: "registry/porta:target-commit", repository: "registry/porta", tag: "target-commit", sourceRevision: "target-commit" }; },
      async pushImage() { calls.push("target.pushImage"); return { reference: "registry/porta:target-commit", repository: "registry/porta", tag: "target-commit", sourceRevision: "target-commit", digest: "sha256:digest", latestReference: "registry/porta:latest" }; },
      async deploy() { calls.push("wrong.target.deploy"); return { status: "triggered" as const }; },
      async qualify() { return { ready: true, correctRevision: true, taskStateAvailable: true }; },
    };
    const coordinator = { async deploy() { calls.push("orchestrator.deploy"); return { status: "triggered" as const }; }, async qualify() { return { ready: true, correctRevision: true, taskStateAvailable: true }; } };
    const registry = new TargetRegistry(); registry.register({ id: "pc-test", kind: "test", workspace: { id: "pc-workspace", path: "/pc/workspace" }, async available() { return true; }, async capabilities() { return ["git.commit", "git.push", "image.build", "image.push"]; }, release: targetRelease });
    const tasks = new MemoryTaskStore(); await tasks.create("release-session", "release target fixture", [], base);
    const runner = new DevelopmentRunner(tasks, { async run() { throw new Error("development driver should not run"); } }, { targets: registry, deploymentCoordinator: coordinator });
    const result = await runner.release("release-session");
    expect(calls).toEqual(["target.commit", "target.push", "target.build", "target.pushImage", "orchestrator.deploy"]);
    expect(result.development?.commitSha).toBe("target-commit");
    expect(result.development?.executionRecords?.filter((record) => ["git", "build", "image_push"].includes(record.category)).every((record) => record.targetId === "pc-test")).toBe(true);
    expect(result.development?.deployment?.target).toBe("porta-nas");
    expect(result.development?.deployment?.status).toBe("awaiting_recovery");
  });

  it("does not fall back to local release capabilities for a bound target", async () => {
    const registry = new TargetRegistry(); registry.register({ id: "pc-test", kind: "test", workspace: { id: "pc-workspace", path: "/pc/workspace" }, async available() { return true; }, async capabilities() { return ["git.commit"]; } });
    const tasks = new MemoryTaskStore(); await tasks.create("release-missing", "release target fixture", [], base);
    const runner = new DevelopmentRunner(tasks, { async run() { throw new Error("not used"); } }, { targets: registry, release: { async commit() { throw new Error("local fallback"); }, async push() { throw new Error("local fallback"); }, async build() { throw new Error("local fallback"); }, async pushImage() { throw new Error("local fallback"); }, async deploy() { throw new Error("local fallback"); }, async qualify() { return { ready: false, correctRevision: false, taskStateAvailable: false }; } } });
    const result = await runner.release("release-missing");
    expect(result.development?.attention?.reason).toBe("target_unavailable");
    expect(result.development?.attention?.message).toContain("git.push");
  });
});
