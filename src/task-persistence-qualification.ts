import { createHash } from "node:crypto";
import type { Task, TaskStatus, DevelopmentPhase } from "./task.js";

export interface PersistenceTaskSnapshot {
  readonly id: string;
  readonly version: number;
  readonly status: TaskStatus;
  readonly developmentPhase?: DevelopmentPhase;
  readonly attention?: string;
  readonly goal: string;
  readonly createdAt: string;
}

export interface PersistenceTaskSnapshotSet {
  readonly capturedAt: string;
  readonly taskCount: number;
  readonly tasks: readonly PersistenceTaskSnapshot[];
  readonly taskIds: readonly string[];
  readonly identityHash: string;
  readonly durableStateHash: string;
}

export interface PersistenceTaskComparison {
  readonly survivingTaskIds: readonly string[];
  readonly missingTaskIds: readonly string[];
  readonly newTaskIds: readonly string[];
  readonly unchangedTaskIds: readonly string[];
  readonly allowedRecoveryTransitions: readonly string[];
  readonly unexpectedDifferences: readonly { readonly taskId: string; readonly before: PersistenceTaskSnapshot; readonly after: PersistenceTaskSnapshot }[];
  readonly pass: boolean;
}

export function persistenceTaskSnapshot(task: Task): PersistenceTaskSnapshot {
  return {
    id: task.id,
    version: task.version,
    status: task.status,
    ...(task.development?.phase ? { developmentPhase: task.development.phase } : {}),
    ...(task.development?.attention ? { attention: `${task.development.attention.reason}:${task.development.attention.message}` } : {}),
    goal: task.objective,
    createdAt: task.createdAt,
  };
}

export function capturePersistenceTaskSnapshot(tasks: readonly Task[], capturedAt = new Date().toISOString()): PersistenceTaskSnapshotSet {
  const snapshots = tasks.map(persistenceTaskSnapshot).sort((left, right) => left.id.localeCompare(right.id));
  const taskIds = snapshots.map((task) => task.id);
  return {
    capturedAt,
    taskCount: snapshots.length,
    tasks: snapshots,
    taskIds,
    identityHash: hashCanonical(taskIds),
    durableStateHash: hashCanonical(snapshots),
  };
}

export function comparePersistenceTaskSnapshots(before: PersistenceTaskSnapshotSet, after: PersistenceTaskSnapshotSet, allowRecoveryTransition?: (before: PersistenceTaskSnapshot, after: PersistenceTaskSnapshot) => boolean): PersistenceTaskComparison {
  const beforeById = new Map(before.tasks.map((task) => [task.id, task]));
  const afterById = new Map(after.tasks.map((task) => [task.id, task]));
  const survivingTaskIds = before.taskIds.filter((id) => afterById.has(id));
  const missingTaskIds = before.taskIds.filter((id) => !afterById.has(id));
  const newTaskIds = after.taskIds.filter((id) => !beforeById.has(id));
  const unchangedTaskIds: string[] = [];
  const allowedRecoveryTransitions: string[] = [];
  const unexpectedDifferences: { taskId: string; before: PersistenceTaskSnapshot; after: PersistenceTaskSnapshot }[] = [];
  for (const id of survivingTaskIds) {
    const left = beforeById.get(id)!;
    const right = afterById.get(id)!;
    if (JSON.stringify(left) === JSON.stringify(right)) unchangedTaskIds.push(id);
    else if (allowRecoveryTransition?.(left, right)) allowedRecoveryTransitions.push(id);
    else unexpectedDifferences.push({ taskId: id, before: left, after: right });
  }
  return { survivingTaskIds, missingTaskIds, newTaskIds, unchangedTaskIds, allowedRecoveryTransitions, unexpectedDifferences, pass: missingTaskIds.length === 0 && unexpectedDifferences.length === 0 };
}

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
