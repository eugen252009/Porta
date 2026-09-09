import { createHash } from "node:crypto";

export type SupervisorPhase = "EXPLORE" | "EXECUTE" | "STABILIZE" | "QUIESCENT";
export type EngineeringTaskStatus = "ready" | "running" | "blocked" | "completed" | "failed" | "awaiting_integration" | "integrated" | "human_review_required";
export type EngineeringTaskKind = "research" | "implementation" | "benchmark" | "qualification" | "integration" | "stabilization" | "audit";
export type DriftLevel = "LOW" | "MEDIUM" | "HIGH";
export interface EngineeringTask {
  readonly id: string; readonly objective: string; readonly kind: EngineeringTaskKind; readonly status: EngineeringTaskStatus;
  readonly repository: string; readonly targetBranch: string; readonly baseCommit?: string; readonly workBranch?: string; readonly worktree?: string;
  readonly dependsOn: readonly string[]; readonly blockedBy: readonly string[]; readonly expectedAreas: readonly string[]; readonly actualAreas: readonly string[];
  readonly assignedWorker?: string; readonly createdAt: string; readonly updatedAt: string; readonly result?: string; readonly evidence?: readonly string[];
}
export interface SupervisorRun { readonly runId: string; readonly repository: string; readonly targetBranch: string; readonly phase: SupervisorPhase; readonly tasks: readonly EngineeringTask[]; readonly integratedCommits: readonly string[]; readonly openBranches: readonly string[]; readonly findings: readonly string[]; readonly humanBlockers: readonly string[]; readonly startedAt: string; readonly updatedAt: string }
export interface DriftInput { readonly baseCommit: string; readonly targetCommit: string; readonly featureCommit: string; readonly targetFiles: readonly string[]; readonly featureFiles: readonly string[] }
export function driftLevel(input: DriftInput): DriftLevel { const target = new Set(input.targetFiles); const feature = new Set(input.featureFiles); const overlap = [...feature].filter((file) => target.has(file)); if (!overlap.length) return "LOW"; if (overlap.length > 2 || overlap.some((file) => file.includes("contract") || file.includes("schema") || file.includes("runtime"))) return "HIGH"; return "MEDIUM"; }
export function canRun(task: EngineeringTask, tasks: readonly EngineeringTask[]): boolean { return task.status === "ready" && task.dependsOn.every((id) => tasks.find((candidate) => candidate.id === id)?.status === "integrated" || tasks.find((candidate) => candidate.id === id)?.status === "completed"); }
export function overlaps(a: EngineeringTask, b: EngineeringTask): boolean { return a.expectedAreas.some((area) => b.expectedAreas.some((other) => area === other || area.startsWith(`${other}/`) || other.startsWith(`${area}/`))); }
export function selectRunnable(tasks: readonly EngineeringTask[], capacity = 2): readonly EngineeringTask[] { const selected: EngineeringTask[] = []; for (const task of tasks) { if (!canRun(task, tasks)) continue; if (selected.some((other) => overlaps(task, other))) continue; selected.push(task); if (selected.length >= Math.max(1, capacity)) break; } return selected; }
export function reconcileTasks(tasks: readonly EngineeringTask[]): readonly EngineeringTask[] { const now = new Date().toISOString(); return tasks.map((task) => task.status === "running" ? { ...task, status: "failed", result: "execution_interrupted", updatedAt: now } : task); }
export function shouldQuiesce(run: Pick<SupervisorRun, "tasks" | "findings" | "humanBlockers">): boolean { return !run.tasks.some((task) => task.status === "ready" || task.status === "running" || task.status === "awaiting_integration") && run.findings.length === 0 && run.humanBlockers.length > 0; }
export function runId(repository: string, targetBranch: string, startedAt: string): string { return `run-${createHash("sha256").update(`${repository}\0${targetBranch}\0${startedAt}`).digest("hex").slice(0, 16)}`; }
