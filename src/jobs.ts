import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { ApplicationGateway, ExecutionMode, KernelEvent, ModelSelection } from "./contracts.js";

export type JobStatus = "queued" | "running" | "needs_attention" | "completed" | "failed" | "interrupted" | "cancelled";
export interface JobActivity { sequence: number; at: string; kind: "user" | "assistant" | "note" | "error"; text: string }
export interface Job {
  id: string; key: string; sessionId: string; nodeId: string; input: string; mode?: ExecutionMode; historyBaseMessageCount?: number;
  status: JobStatus; createdAt: string; updatedAt: string; version: number;
  model?: ModelSelection; workspace?: string; allowedTools: readonly string[];
  timeoutMs: number; activity: JobActivity[]; nextSequence: number;
  failure?: string; verification: "not_recorded" | "checks_recorded"; truncated: boolean;
  checks: { toolId: string; exitCode: number; summary: string }[];
  budget: { maxSteps: number; maxToolCalls: number }; executionId?: string;
}
export interface JobStore {
  get(id: string): Job | undefined;
  byKey(key: string): Job | undefined;
  list(): Job[];
  insert(job: Job): Job;
  save(job: Job, expectedVersion: number): void;
}
const jobSchema = z.object({
  id: z.string().min(1), key: z.string().min(1), sessionId: z.string().min(1), nodeId: z.string().min(1), input: z.string().min(1).max(524288), mode: z.enum(["chat", "agent"]).optional(), historyBaseMessageCount: z.number().int().nonnegative().optional(),
  status: z.enum(["queued", "running", "needs_attention", "completed", "failed", "interrupted", "cancelled"]),
  createdAt: z.string(), updatedAt: z.string(), version: z.number().int().positive(),
  model: z.object({ provider: z.string(), model: z.string() }).optional(), workspace: z.string().optional(), allowedTools: z.array(z.string()),
  timeoutMs: z.number().int().positive().max(86400000), activity: z.array(z.object({ sequence: z.number().int().positive(), at: z.string(), kind: z.enum(["user", "assistant", "note", "error"]), text: z.string().max(32000) })).max(256),
  nextSequence: z.number().int().positive(), failure: z.string().optional(), verification: z.enum(["not_recorded", "checks_recorded"]), truncated: z.boolean(),
  checks: z.array(z.object({ toolId: z.string(), exitCode: z.number(), summary: z.string().max(4000) })).max(64),
  budget: z.object({ maxSteps: z.number().int().positive(), maxToolCalls: z.number().int().positive() }), executionId: z.string().optional(),
}).strict();
const copy = <T>(value: T): T => structuredClone(value);
export class MemoryJobStore implements JobStore {
  private readonly records = new Map<string, Job>();
  get(id: string) { const value = this.records.get(id); return value ? copy(value) : undefined; }
  byKey(key: string) { return this.list().find((job) => job.key === key); }
  list() { return [...this.records.values()].map(copy); }
  insert(job: Job) { jobSchema.parse(job); const existing = this.byKey(job.key); if (existing) return existing; this.records.set(job.id, copy(job)); return copy(job); }
  save(job: Job, expectedVersion: number) { jobSchema.parse(job); if (job.version !== expectedVersion + 1) throw new Error("Job version must increase by one"); if (this.records.get(job.id)?.version !== expectedVersion) throw new Error("Stale job update"); this.records.set(job.id, copy(job)); }
}
/** Uses the application's existing SQLite connection and single-writer lifecycle. */
export class SqliteJobStore implements JobStore {
  constructor(private readonly db: DatabaseSync) {}
  private decode(row: unknown): Job | undefined { return row ? jobSchema.parse(JSON.parse((row as { payload: string }).payload)) : undefined; }
  get(id: string) { return this.decode(this.db.prepare("SELECT payload FROM jobs WHERE id=?").get(id)); }
  byKey(key: string) { return this.decode(this.db.prepare("SELECT payload FROM jobs WHERE receipt_key=?").get(key)); }
  list() { return this.db.prepare("SELECT payload FROM jobs ORDER BY rowid").all().map((row) => this.decode(row)!); }
  insert(job: Job) {
    jobSchema.parse(job);
    this.db.prepare("INSERT OR IGNORE INTO jobs(id,receipt_key,session_id,version,payload) VALUES(?,?,?,?,?)").run(job.id, job.key, job.sessionId, job.version, JSON.stringify(job));
    const stored = this.byKey(job.key); if (!stored) throw new Error("Job acceptance was not persisted"); return stored;
  }
  save(job: Job, expectedVersion: number) {
    jobSchema.parse(job);
    if (job.version !== expectedVersion + 1) throw new Error("Job version must increase by one");
    const result = this.db.prepare("UPDATE jobs SET payload=?,version=? WHERE id=? AND version=?").run(JSON.stringify(job), job.version, job.id, expectedVersion);
    if (result.changes !== 1) throw new Error("Stale job update");
  }
}
export const jobTerminal = (status: JobStatus) => ["completed", "failed", "interrupted", "cancelled"].includes(status);
export interface JobRunnerOptions {
  timeoutMs?: number; maxQueued?: number; workspace?: string; allowedTools?: readonly string[];
  budget?: { maxSteps: number; maxToolCalls: number };
  enterScope?(sessionId: string, tools: readonly string[]): void; leaveScope?(sessionId: string): void;
  changed?(job: Job): void;
}
/** One application-owned worker. HTTP and SSE clients are observers, never owners. */
export class JobRunner {
  private running?: Promise<void>;
  private stopped = false;
  private started = false;
  private controller?: AbortController;
  private activeId?: string;
  constructor(readonly store: JobStore, private readonly gateway: ApplicationGateway, private readonly options: JobRunnerOptions = {}) {}
  accept(input: { key: string; sessionId: string; nodeId: string; input: string; mode?: ExecutionMode; model?: ModelSelection; historyBaseMessageCount?: number }): Job {
    if (this.stopped) throw new Error("Porta is shutting down");
    const existing = this.store.byKey(input.key); if (existing) return existing;
    if (!input.input.trim() || Buffer.byteLength(input.input) > 512 * 1024) throw new Error("Prompt must contain 1–524288 bytes");
    if (this.store.list().filter((job) => !jobTerminal(job.status)).length >= (this.options.maxQueued ?? 32)) throw new Error("Porta job queue is full");
    const now = new Date().toISOString();
    const job = this.store.insert({ ...input, id: randomUUID(), status: "queued", createdAt: now, updatedAt: now, version: 1, timeoutMs: this.options.timeoutMs ?? 1800000, workspace: this.options.workspace, allowedTools: this.options.allowedTools ?? [], verification: "not_recorded", checks: [], budget: this.options.budget ?? { maxSteps: 8, maxToolCalls: 16 }, activity: [{ sequence: 1, at: now, kind: "user", text: input.input.slice(0, 32000) }], nextSequence: 2, truncated: input.input.length > 32000 });
    this.options.changed?.(job);
    this.wake();
    return job;
  }
  latest(sessionId: string) {
    const jobs = this.store.list().filter((job) => job.sessionId === sessionId);
    return jobs.find((job) => job.status === "running" || job.status === "needs_attention") ?? jobs.find((job) => job.status === "queued") ?? jobs.at(-1);
  }
  sessionHistory(sessionId: string) { return this.store.list().filter((job) => job.sessionId === sessionId).slice(-20); }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    // Never replay a previously started side effect, even if its final outcome is unknown.
    for (const job of this.store.list()) if (job.id !== this.activeId && (job.status === "running" || job.status === "needs_attention")) {
      job.status = "interrupted"; job.failure = "Porta restarted during execution. Not replayed automatically.";
      this.append(job, "error", job.failure); this.save(job);
    }
    this.wake();
  }
  async stop() { this.stopped = true; this.controller?.abort(); await this.running; }
  async cancelSession(sessionId: string) {
    for (const job of this.store.list()) if (job.sessionId === sessionId && !jobTerminal(job.status)) {
      if (job.id === this.activeId) this.controller?.abort();
      else { job.status = "cancelled"; this.append(job, "note", "Cancelled before execution."); this.save(job); }
    }
  }
  private wake() {
    if (this.running || this.stopped) return;
    // Defer so acceptance returns only the durable receipt, not model output.
    this.running = Promise.resolve().then(() => this.drain()).catch((error) => {
      // Storage failures stop this worker rather than acknowledging further side effects.
      this.stopped = true;
      throw error;
    }).finally(() => {
      this.running = undefined;
      // An acceptance can arrive between drain's final queue check and this microtask.
      if (!this.stopped && this.store.list().some((job) => job.status === "queued")) this.wake();
    });
    void this.running.catch(() => { this.stopped = true; });
  }
  private async drain() {
    while (!this.stopped) {
      const job = this.store.list().find((candidate) => candidate.status === "queued"); if (!job) return;
      await this.execute(job);
    }
  }
  private save(job: Job) { const previous = job.version; job.version++; job.updatedAt = new Date().toISOString(); this.store.save(job, previous); this.options.changed?.(job); }
  private append(job: Job, kind: JobActivity["kind"], text: string) {
    // A bounded observational journal; canonical successful turns and tool artifacts remain separate.
    const last = job.activity.at(-1);
    if (kind === "assistant" && last?.kind === kind && last.text.length + text.length <= 32000) last.text += text;
    else job.activity.push({ sequence: job.nextSequence++, at: new Date().toISOString(), kind, text: text.slice(0, 32000) });
    if (text.length > 32000) job.truncated = true;
    while (job.activity.length > 256 || job.activity.reduce((sum, item) => sum + item.text.length, 0) > 256000) { job.activity.splice(1, 1); job.truncated = true; }
  }
  private async execute(job: Job) {
    const budget = this.options.budget ?? { maxSteps: 8, maxToolCalls: 16 };
    if (job.workspace !== this.options.workspace || job.budget.maxSteps !== budget.maxSteps || job.budget.maxToolCalls !== budget.maxToolCalls) {
      job.status = "failed"; job.failure = "Workspace or execution budget changed since acceptance. Submit a new job after reviewing configuration."; this.append(job, "error", job.failure); this.save(job); return;
    }
    job.status = "running"; this.append(job, "note", "Porta started this job. The browser can be closed."); this.save(job);
    const controller = new AbortController(); this.controller = controller; this.activeId = job.id;
    let timedOut = false; let completed = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, job.timeoutMs);
    this.options.enterScope?.(job.sessionId, job.allowedTools);
    try {
      for await (const event of this.gateway.execute({ type: "SubmitInput", sessionId: job.sessionId, input: job.input, mode: job.mode ?? "agent" }, { signal: controller.signal })) {
        if (event.type === "ExecutionCompleted") completed = true;
        this.event(job, event); this.save(job);
      }
      // Gateway iteration must finish (including conversation commit) before completion is durable.
      if (controller.signal.aborted) { job.status = this.stopped ? "interrupted" : timedOut ? "failed" : "cancelled"; job.failure = this.stopped ? "Porta stopped during execution. Not replayed automatically." : timedOut ? "Job deadline exceeded." : "Cancelled by user."; }
      else if (!jobTerminal(job.status)) { job.status = completed ? "completed" : "failed"; if (!completed) job.failure = "Execution ended without a completion result."; }
      this.append(job, job.status === "completed" ? "note" : "error", job.failure ?? "Execution finished. Task verification is not independently certified; inspect the recorded checks and final report.");
      this.save(job);
    } catch (error) {
      controller.abort(); job.status = "failed"; job.failure = error instanceof Error ? error.message.slice(0, 2000) : "Job execution failed";
      this.append(job, "error", job.failure); this.save(job);
    } finally { clearTimeout(timer); this.options.leaveScope?.(job.sessionId); this.controller = undefined; this.activeId = undefined; }
  }
  private event(job: Job, event: KernelEvent) {
    if (event.type === "ExecutionStarted") job.executionId = event.executionId;
    else if (event.type === "OutputDelta") { job.status = "running"; this.append(job, "assistant", event.text); }
    else if (event.type === "ApprovalRequested") { job.status = "needs_attention"; this.append(job, "note", `Approval required: ${event.toolId}. Open Porta to approve or reject.`); }
    else if (event.type === "ApprovalResolved") { job.status = "running"; this.append(job, "note", `Approval ${event.decision === "approve" ? "granted" : "denied"}${event.reason ? `: ${event.reason}` : "."}`); }
    else if (event.type === "ToolStarted" || event.type === "ToolRequested") { job.status = "running"; this.append(job, "note", `${event.type}: ${event.toolId}`); }
    else if (event.type === "ToolCompleted") {
      this.append(job, event.result?.error ? "error" : "note", `${event.toolId}: ${event.result?.error?.message ?? "tool returned"}`);
      const output = event.result?.output;
      if (event.toolId === "execution/run" && output && typeof output === "object" && "exitCode" in output && typeof output.exitCode === "number") {
        const summary = JSON.stringify(output).slice(0, 4000);
        job.checks.push({ toolId: event.toolId, exitCode: output.exitCode, summary }); if (job.checks.length > 64) { job.checks.shift(); job.truncated = true; }
        job.verification = "checks_recorded";
        this.append(job, output.exitCode === 0 ? "note" : "error", `Command exited ${output.exitCode}: ${summary}`);
      }
    }
    else if (event.type === "Error") { job.status = "failed"; job.failure = event.error.message; this.append(job, "error", event.error.message); }
    else if (event.type === "ExecutionCancelled") { job.status = "cancelled"; job.failure = "Execution cancelled or timed out."; }
  }
}
