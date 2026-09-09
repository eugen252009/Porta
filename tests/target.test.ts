import { describe, expect, it } from "vitest";
import { TargetRegistry } from "../src/target.js";
import { GatewayDevelopmentPhaseDriver, DevelopmentRunner } from "../src/development-runner.js";
import { MemoryTaskStore } from "../src/task.js";
import type { ApplicationGateway } from "../src/contracts.js";

const gateway = (calls: string[]): ApplicationGateway => ({ async *execute(command) { calls.push(command.type); if (command.type === "SubmitInput") yield { type: "ExecutionCompleted" }; } });
const development = { goal: "target fixture", acceptanceCriteria: ["read"], developmentTargetId: "pc-test", workspace: { id: "workspace-pc-test", path: "/target/workspace" }, permissions: { mutate: false, commit: false, push: false, deploy: false }, focusedCommands: [], fullCommands: [], phase: "inspecting" as const, updatedAt: "2024-01-01T00:00:00.000Z" };

describe("execution targets", () => {
  it("resolves stable identity and capability discovery", async () => {
    const registry = new TargetRegistry();
    registry.register({ id: "pc-test", kind: "test", workspace: { id: "workspace-pc-test", path: "/target/workspace" }, async available() { return true; }, async capabilities() { return ["filesystem.read", "filesystem.write", "execution.run"]; } });
    const result = await registry.qualify("pc-test");
    expect(result?.target.id).toBe("pc-test");
    expect(result?.capabilities).toContain("filesystem.write");
  });

  it("routes a phase through the bound target gateway", async () => {
    const localCalls: string[] = []; const targetCalls: string[] = [];
    const registry = new TargetRegistry();
    registry.register({ id: "pc-test", kind: "test", async available() { return true; }, async capabilities() { return ["filesystem.read"]; }, gateway: gateway(targetCalls) });
    const driver = new GatewayDevelopmentPhaseDriver(gateway(localCalls));
    const tasks = new MemoryTaskStore(); await tasks.create("session-target", "target fixture", [], development);
    const runner = new DevelopmentRunner(tasks, driver, { targets: registry });
    const result = await runner.wake("session-target");
    expect(result?.development?.phase).toBe("implementing");
    expect(targetCalls).toContain("SubmitInput");
    expect(localCalls).toEqual([]);
  });

  it("does not silently fall back to local execution when the target is unavailable", async () => {
    const localCalls: string[] = []; const registry = new TargetRegistry();
    registry.register({ id: "pc-test", kind: "test", async available() { return false; }, async capabilities() { return []; }, gateway: gateway(localCalls) });
    const tasks = new MemoryTaskStore(); await tasks.create("session-unavailable", "target fixture", [], development);
    const runner = new DevelopmentRunner(tasks, { async run() { throw new Error("local fallback"); } }, { targets: registry });
    const result = await runner.wake("session-unavailable");
    expect(result?.development?.attention?.reason).toBe("target_unavailable");
    expect(localCalls).toEqual([]);
  });

  it("persists target and workspace identity through task storage", async () => {
    const tasks = new MemoryTaskStore(); const created = await tasks.create("session-persist", "target fixture", [], development);
    const restored = await tasks.get("session-persist");
    expect(restored?.development?.developmentTargetId).toBe(created.development?.developmentTargetId);
    expect(restored?.development?.workspace.id).toBe("workspace-pc-test");
  });
});
