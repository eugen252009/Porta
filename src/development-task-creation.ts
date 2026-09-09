import { randomUUID } from "node:crypto";
import type { ConversationStore } from "./contracts.js";
import { sessionFromBase } from "./conversation.js";
import type { TargetRegistry } from "./target.js";
import type { DevelopmentPermissionIntent, DevelopmentState, Task, TaskStore } from "./task.js";

export interface DevelopmentTaskCreationSpec {
  readonly goal: string;
  readonly targetId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly acceptanceCriteria: readonly string[];
  readonly permissions: DevelopmentPermissionIntent;
  readonly constraints?: readonly string[];
  readonly focusedCommands?: readonly string[];
  readonly fullCommands?: readonly string[];
}

/** Creates only durable task/session state. It never starts a runner or performs a mutation. */
export class DevelopmentTaskCreationService {
  constructor(private readonly tasks: TaskStore, private readonly targets: TargetRegistry, private readonly conversations: ConversationStore) {}
  async create(spec: DevelopmentTaskCreationSpec): Promise<Task> {
    validateSpec(spec);
    const resolution = await this.targets.qualify(spec.targetId);
    if (!resolution) throw new Error(`Development target '${spec.targetId}' is unavailable.`);
    const workspace = resolution.target.workspace;
    if (!workspace || workspace.id !== spec.workspaceId || workspace.path !== spec.workspacePath) throw new Error("Development task workspace does not match the target workspace.");
    const required = requiredCapabilities(spec.permissions);
    const missing = required.find((capability) => !resolution.capabilities.includes(capability));
    if (missing) throw new Error(`Development target '${spec.targetId}' lacks capability '${missing}'.`);
    const duplicate = (await this.tasks.list()).find((task) => task.status === "active" && task.development?.goal === spec.goal && task.development.developmentTargetId === spec.targetId && task.development.workspace.id === spec.workspaceId);
    if (duplicate) return duplicate;
    const sessionId = `development-${randomUUID()}`;
    const now = new Date().toISOString();
    await this.conversations.createSession(sessionFromBase({ schemaVersion: 1, id: sessionId, state: "open", createdAt: now }));
    const development: DevelopmentState = {
      goal: spec.goal,
      acceptanceCriteria: [...spec.acceptanceCriteria],
      developmentTargetId: spec.targetId,
      workspace: { id: spec.workspaceId, path: spec.workspacePath },
      permissions: { ...spec.permissions },
      focusedCommands: [...(spec.focusedCommands ?? [])],
      fullCommands: [...(spec.fullCommands ?? [])],
      phase: "queued",
      updatedAt: now,
    };
    return this.tasks.create(sessionId, spec.goal, spec.constraints ?? [], development);
  }
  async cancel(taskId: string): Promise<Task> {
    const task = (await this.tasks.list()).find((entry) => entry.id === taskId);
    if (!task || !task.development) throw new Error("Development task was not found.");
    return this.tasks.update(task.sessionId, task.id, task.version, { type: "set_status", status: "cancelled", reason: "cancelled_by_operator" });
  }
}

function validateSpec(spec: DevelopmentTaskCreationSpec): void {
  if (!spec.goal.trim() || spec.goal.length > 300) throw new Error("Development task goal is invalid.");
  if (!spec.targetId.trim() || !spec.workspaceId.trim() || !spec.workspacePath.trim()) throw new Error("Target and workspace binding are required.");
  if (!spec.acceptanceCriteria.length || spec.acceptanceCriteria.length > 32 || spec.acceptanceCriteria.some((criterion) => !criterion.trim() || criterion.length > 500)) throw new Error("Acceptance criteria are invalid or exceed the bounded limit.");
  for (const value of Object.values(spec.permissions)) if (typeof value !== "boolean") throw new Error("Development permissions must be boolean values.");
}
function requiredCapabilities(permissions: DevelopmentPermissionIntent): readonly ("filesystem.write" | "git.commit" | "git.push" | "image.build" | "image.push")[] {
  return [ ...(permissions.mutate ? ["filesystem.write" as const] : []), ...(permissions.commit ? ["git.commit" as const] : []), ...(permissions.push ? ["git.push" as const, "image.build" as const, "image.push" as const] : []) ];
}
