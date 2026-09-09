import { describe, expect, it, vi } from "vitest";
import { DevelopmentTaskCreationService } from "../src/development-task-creation.js";
import { MemoryTaskStore } from "../src/task.js";
import { MemoryConversationStore } from "../src/conversation.js";
import { TargetRegistry } from "../src/target.js";

function setup() { const tasks = new MemoryTaskStore(); const conversations = new MemoryConversationStore(); const targets = new TargetRegistry(); targets.register({ id: "pc-main", kind: "remote", workspace: { id: "porta-main", path: "/workspace", }, async available() { return true; }, async capabilities() { return ["filesystem.write", "git.commit", "git.push", "image.build", "image.push"] as const; } }); return { tasks, conversations, service: new DevelopmentTaskCreationService(tasks, targets, conversations) }; }
const spec = { goal: "live qualification", targetId: "pc-main", workspaceId: "porta-main", workspacePath: "/workspace", acceptanceCriteria: ["marker exists", "release completes"], permissions: { mutate: true, commit: true, push: true, deploy: true }, focusedCommands: ["focused"], fullCommands: ["full"] } as const;

describe("deterministic development task creation", () => {
  it("creates session before queued task without invoking a model or mutation", async () => { const { tasks, conversations, service } = setup(); const task = await service.create(spec); expect(task.development).toMatchObject({ phase: "queued", developmentTargetId: "pc-main", workspace: { id: "porta-main", path: "/workspace" }, permissions: spec.permissions, acceptanceCriteria: spec.acceptanceCriteria }); expect(await conversations.getSession(task.sessionId)).toMatchObject({ id: task.sessionId, state: "open" }); expect(await tasks.list()).toHaveLength(1); });
  it("rejects unknown and mismatched workspaces", async () => { const { service } = setup(); await expect(service.create({ ...spec, targetId: "missing" })).rejects.toThrow("unavailable"); await expect(service.create({ ...spec, workspaceId: "wrong" })).rejects.toThrow("does not match"); });
  it("returns the existing active equivalent instead of duplicating it", async () => { const { service, tasks } = setup(); const first = await service.create(spec); const second = await service.create(spec); expect(second.id).toBe(first.id); expect(await tasks.list()).toHaveLength(1); });
  it("does not need a model provider", async () => { const model = vi.fn(); const { service } = setup(); await service.create(spec); expect(model).not.toHaveBeenCalled(); });
  it("does not permit malformed or overlarge specifications", async () => { const { service } = setup(); await expect(service.create({ ...spec, acceptanceCriteria: [] })).rejects.toThrow("Acceptance"); await expect(service.create({ ...spec, permissions: { ...spec.permissions, push: "yes" } as never })).rejects.toThrow("boolean"); });
});
