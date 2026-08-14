import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HarnessFailure, JsonValue, ToolContext, ToolDescriptor, ToolInvocation, ToolProvider, ToolResult, failure } from "./contracts.js";

export type TaskStatus = "pending" | "active" | "blocked" | "completed" | "failed" | "cancelled";
export type TaskStepStatus = "pending" | "active" | "completed" | "blocked" | "skipped";
export type VerificationOutcome = "pass" | "fail" | "inconclusive";
export type VerificationSource = "execution" | "filesystem" | "tool" | "manual";
export interface TaskStep { readonly id: string; readonly description: string; readonly status: TaskStepStatus }
export interface VerificationCriterion { readonly id: string; readonly description: string; readonly required: boolean }
export interface VerificationEvidence { readonly id: string; readonly criterionId: string; readonly source: VerificationSource; readonly outcome: VerificationOutcome; readonly summary: string; readonly executionId?: string; readonly toolCallId?: string; readonly recordedAt: string }
export interface Task { readonly id: string; readonly sessionId: string; readonly objective: string; readonly constraints: readonly string[]; readonly status: TaskStatus; readonly steps: readonly TaskStep[]; readonly criteria: readonly VerificationCriterion[]; readonly evidence: readonly VerificationEvidence[]; readonly version: number; readonly createdAt: string; readonly updatedAt: string }
export type TaskUpdate =
  | { readonly type: "add_step"; readonly description: string; readonly stepId?: string }
  | { readonly type: "set_step_status"; readonly stepId: string; readonly status: TaskStepStatus }
  | { readonly type: "add_criterion"; readonly description: string; readonly required?: boolean; readonly criterionId?: string }
  | { readonly type: "add_evidence"; readonly criterionId: string; readonly source: VerificationSource; readonly outcome: VerificationOutcome; readonly summary: string; readonly executionId?: string; readonly toolCallId?: string }
  | { readonly type: "set_status"; readonly status: Exclude<TaskStatus, "pending" | "completed"> }
  | { readonly type: "complete" };

export interface TaskStore {
  create(sessionId: string, objective: string, constraints?: readonly string[]): Promise<Task>;
  get(sessionId: string): Promise<Task | undefined>;
  update(sessionId: string, taskId: string, expectedVersion: number, update: TaskUpdate): Promise<Task>;
}

export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();
  async create(sessionId: string, objective: string, constraints: readonly string[] = []): Promise<Task> {
    if (this.tasks.has(sessionId)) throw failure("CAPABILITY_CONFLICT", "A task already exists for this session.");
    if (!objective.trim()) throw failure("VALIDATION_FAILED", "Task objective must not be empty.");
    const now = new Date().toISOString(); const task: Task = Object.freeze({ id: `task-${randomUUID()}`, sessionId, objective, constraints: [...constraints], status: "active", steps: [], criteria: [], evidence: [], version: 1, createdAt: now, updatedAt: now }); this.tasks.set(sessionId, task); return copyTask(task);
  }
  async get(sessionId: string): Promise<Task | undefined> { const task = this.tasks.get(sessionId); return task ? copyTask(task) : undefined; }
  async update(sessionId: string, taskId: string, expectedVersion: number, update: TaskUpdate): Promise<Task> {
    const current = this.tasks.get(sessionId); if (!current || current.id !== taskId) throw failure("CAPABILITY_UNAVAILABLE", "Task was not found for this session."); if (current.version !== expectedVersion) throw failure("CAPABILITY_CONFLICT", "Task update is stale.", false, { expectedVersion, actualVersion: current.version });
    const next = applyUpdate(current, update); const updated = Object.freeze({ ...next, version: current.version + 1, updatedAt: new Date().toISOString() }); this.tasks.set(sessionId, updated); return copyTask(updated);
  }
}

function applyUpdate(task: Task, update: TaskUpdate): Omit<Task, "version" | "updatedAt"> {
  if (update.type === "add_step") { const step: TaskStep = { id: update.stepId ?? `step-${randomUUID()}`, description: update.description, status: "pending" }; if (!update.description.trim() || task.steps.some((entry) => entry.id === step.id)) throw failure("VALIDATION_FAILED", "Step description must be non-empty and step IDs must be unique."); return { ...task, steps: [...task.steps, step] }; }
  if (update.type === "set_step_status") { const index = task.steps.findIndex((step) => step.id === update.stepId); if (index < 0) throw failure("CAPABILITY_UNAVAILABLE", `Step '${update.stepId}' was not found.`); if (update.status === "active" && task.steps.some((step) => step.status === "active" && step.id !== update.stepId)) throw failure("CAPABILITY_CONFLICT", "Another task step is already active."); const steps = task.steps.map((step, position) => position === index ? { ...step, status: update.status } : step); return { ...task, steps }; }
  if (update.type === "add_criterion") { const criterion: VerificationCriterion = { id: update.criterionId ?? `criterion-${randomUUID()}`, description: update.description, required: update.required ?? true }; if (!update.description.trim() || task.criteria.some((entry) => entry.id === criterion.id)) throw failure("VALIDATION_FAILED", "Criterion description must be non-empty and criterion IDs must be unique."); return { ...task, criteria: [...task.criteria, criterion] }; }
  if (update.type === "add_evidence") { if (!task.criteria.some((criterion) => criterion.id === update.criterionId)) throw failure("CAPABILITY_UNAVAILABLE", `Criterion '${update.criterionId}' was not found.`); if (!update.summary.trim()) throw failure("VALIDATION_FAILED", "Evidence summary must not be empty."); const evidence: VerificationEvidence = { id: `evidence-${randomUUID()}`, criterionId: update.criterionId, source: update.source, outcome: update.outcome, summary: update.summary, ...(update.executionId ? { executionId: update.executionId } : {}), ...(update.toolCallId ? { toolCallId: update.toolCallId } : {}), recordedAt: new Date().toISOString() }; return { ...task, evidence: [...task.evidence, evidence] }; }
  if (update.type === "set_status") return { ...task, status: update.status };
  if (task.criteria.some((criterion) => criterion.required && criterionState(task, criterion.id) !== "pass")) throw failure("POLICY_VIOLATION", "Task cannot be completed until every required verification criterion has passing evidence.", false, { criteria: task.criteria.map((criterion) => ({ id: criterion.id, state: criterionState(task, criterion.id) })) });
  return { ...task, status: "completed" };
}

export function criterionState(task: Task, criterionId: string): "unverified" | VerificationOutcome { const evidence = task.evidence.filter((entry) => entry.criterionId === criterionId); return evidence.length ? evidence[evidence.length - 1]!.outcome : "unverified"; }
export function taskSnapshot(task: Task): string { const current = task.steps.find((step) => step.status === "active"); const criteria = task.criteria.map((criterion) => { const latest = [...task.evidence].reverse().find((evidence) => evidence.criterionId === criterion.id); return `${criterionState(task, criterion.id) === "pass" ? "✓" : criterionState(task, criterion.id) === "fail" ? "✗" : "?"} ${criterion.description}${latest ? ` — ${latest.summary}` : ""}`; }).join("\n") || "- none"; const steps = task.steps.map((step) => `- [${step.status}] ${step.description}`).join("\n") || "- none"; return limit(`Current task (${task.id}, v${task.version}):\nObjective: ${task.objective}\nStatus: ${task.status}\nConstraints:\n${task.constraints.map((constraint) => `- ${constraint}`).join("\n") || "- none"}\nCurrent step: ${current?.description ?? "none"}\nSteps:\n${steps}\nVerification:\n${criteria}`, 6000); }
function limit(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max - 24)}… [task snapshot truncated]`; }
function copyTask(task: Task): Task { return { ...task, constraints: [...task.constraints], steps: task.steps.map((step) => ({ ...step })), criteria: task.criteria.map((criterion) => ({ ...criterion })), evidence: task.evidence.map((evidence) => ({ ...evidence })) }; }

const createSchema = z.object({ objective: z.string().min(1), constraints: z.array(z.string()).default([]) }).strict();
const updateSchema = z.object({ version: z.number().int().positive(), update: z.discriminatedUnion("type", [z.object({ type: z.literal("add_step"), description: z.string().min(1), stepId: z.string().min(1).optional() }), z.object({ type: z.literal("set_step_status"), stepId: z.string().min(1), status: z.enum(["pending", "active", "completed", "blocked", "skipped"]) }), z.object({ type: z.literal("add_criterion"), description: z.string().min(1), required: z.boolean().optional(), criterionId: z.string().min(1).optional() }), z.object({ type: z.literal("add_evidence"), criterionId: z.string().min(1), source: z.enum(["execution", "filesystem", "tool", "manual"]), outcome: z.enum(["pass", "fail", "inconclusive"]), summary: z.string().min(1), executionId: z.string().min(1).optional(), toolCallId: z.string().min(1).optional() }), z.object({ type: z.literal("set_status"), status: z.enum(["active", "blocked", "failed", "cancelled"]) }), z.object({ type: z.literal("complete") })]) }).strict();

export class TaskToolProvider implements ToolProvider {
  readonly providerId = "task";
  constructor(private readonly store: TaskStore) {}
  async listTools(_context: ToolContext): Promise<readonly ToolDescriptor[]> { return [
    { id: "create", name: "task/create", version: "1", description: "Create the session-scoped task objective and constraints.", inputSchema: { type: "object", required: ["objective"], properties: { objective: { type: "string" }, constraints: { type: "array", items: { type: "string" } } } } },
    { id: "get", name: "task/get", version: "1", description: "Read the current session-scoped task, steps, criteria, and immutable evidence.", inputSchema: { type: "object", properties: {} } },
    { id: "update", name: "task/update", version: "1", description: "Apply one atomic versioned task update: add or advance steps, add criteria/evidence, change status, or complete after all required criteria pass.", inputSchema: { type: "object", required: ["version", "update"], properties: { version: { type: "integer" }, update: { type: "object" } } } },
  ]; }
  async invoke(request: ToolInvocation, context: ToolContext): Promise<ToolResult> { try {
    if (request.toolId === "create") { const parsed = createSchema.safeParse(request.input); if (!parsed.success) return invalid(parsed.error.issues); const task = await this.store.create(context.sessionId, parsed.data.objective, parsed.data.constraints); return { ok: true, output: compact(task) }; }
    const task = await this.store.get(context.sessionId); if (!task) return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", "No task exists for this session.").error };
    if (request.toolId === "get") return { ok: true, output: full(task) };
    if (request.toolId !== "update") return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", `Task tool '${request.toolId}' is unavailable.`).error };
    const parsed = updateSchema.safeParse(request.input); if (!parsed.success) return invalid(parsed.error.issues); const updated = await this.store.update(context.sessionId, task.id, parsed.data.version, parsed.data.update as TaskUpdate); return { ok: true, output: compact(updated) };
  } catch (error) { return { ok: false, error: error instanceof HarnessFailure ? error.error : failure("TOOL_FAILED", error instanceof Error ? error.message : "Task operation failed.").error }; } }
}
function compact(task: Task): JsonValue { return { taskId: task.id, version: task.version, status: task.status, currentStep: task.steps.find((step) => step.status === "active")?.id ?? null }; }
function full(task: Task): JsonValue { return { taskId: task.id, version: task.version, status: task.status, currentStep: task.steps.find((step) => step.status === "active")?.id ?? null, objective: task.objective, constraints: task.constraints, steps: task.steps, criteria: task.criteria.map((criterion) => ({ ...criterion, state: criterionState(task, criterion.id) })), evidence: task.evidence, createdAt: task.createdAt, updatedAt: task.updatedAt } as unknown as JsonValue; }
function invalid(issues: unknown): ToolResult { return { ok: false, error: failure("VALIDATION_FAILED", "Task arguments are invalid.", false, { issues }).error }; }
