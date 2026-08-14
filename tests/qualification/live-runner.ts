import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPortaApplication, PortaFactories } from "../../src/porta-application.js";
import { parsePortaConfig, PortaConfig } from "../../src/porta-config.js";
import { KernelEvent, ModelContext, ModelEvent, ModelProvider, ModelRequest, ToolContext } from "../../src/contracts.js";
import { HostProcessRuntime } from "../../src/adapters/runtime-host-process.js";
import { HostProcessSandbox } from "../../src/adapters/sandbox-host-process.js";
import { DeterministicConversationCompactor } from "../../src/compaction.js";
import { fixtures, FixtureDefinition, FixtureInstance, FixtureVerification } from "./fixtures.js";

export type QualificationOutcome = "success" | "repo-fixed-but-task-incomplete" | "verification-failed" | "scope-violation" | "budget-exhausted" | "model-error" | "tool-error" | "policy-denied" | "invalid-completion";
export interface QualificationBudget { maxTurns: number; maxToolCalls: number; maxExecutions: number; maxMutations: number; maxDurationMs: number }
export interface QualificationMetrics { turns: number; toolCalls: number; executions: number; mutations: number; gitInspections: number; artifactSearches: number; artifactReads: number; scratchpadReads: number; scratchpadWrites: number; taskUpdates: number; compactions: number; durationMs: number; toolsById: Readonly<Record<string, number>> }
export interface QualificationFinal extends FixtureVerification { taskCompleted: boolean; taskId?: string; taskEvidencePass: boolean; artifactCreated: boolean; artifactOffContext: boolean }
export interface QualificationResult { fixture: string; description: string; model: string; outcome: QualificationOutcome; budget: QualificationBudget; metrics: QualificationMetrics; final: QualificationFinal; trace: readonly string[]; errors: readonly string[] }

export const defaultBudget: QualificationBudget = { maxTurns: 20, maxToolCalls: 60, maxExecutions: 6, maxMutations: 6, maxDurationMs: 180_000 };
export function budgetExceeded(metrics: Pick<QualificationMetrics, "toolCalls" | "executions" | "mutations">, budget: QualificationBudget): boolean { return metrics.toolCalls > budget.maxToolCalls || metrics.executions > budget.maxExecutions || metrics.mutations > budget.maxMutations; }
export function summarizeToolTrace(trace: readonly string[]): { toolCalls: number; executions: number; mutations: number; toolsById: Readonly<Record<string, number>> } { const toolsById: Record<string, number> = {}; for (const toolId of trace) toolsById[toolId] = (toolsById[toolId] ?? 0) + 1; return { toolCalls: trace.length, executions: toolsById["execution/run"] ?? 0, mutations: (toolsById["filesystem/patch_file"] ?? 0) + (toolsById["filesystem/write_file"] ?? 0), toolsById }; }

class ObservedModel implements ModelProvider {
  readonly requests: ModelRequest[] = []; fullArtifactVisibleBeforeRead = false; private artifactReadSeen = false;
  constructor(private readonly inner: ModelProvider) {}
  get descriptor() { return this.inner.descriptor; }
  async *generate(request: ModelRequest, context: ModelContext): AsyncIterable<ModelEvent> { const serialized = JSON.stringify(request); const readInHistory = Boolean(request.messages?.some((message) => message.role === "tool" && message.toolId === "artifact/read")); if (!this.artifactReadSeen && !readInHistory && serialized.includes("diagnostic-70")) this.fullArtifactVisibleBeforeRead = true; if (readInHistory) this.artifactReadSeen = true; this.requests.push(request); yield* this.inner.generate(request, context); }
}

export interface LiveRunnerOptions { readonly baseConfig: PortaConfig; readonly budget?: Partial<QualificationBudget>; readonly fixtures?: readonly FixtureDefinition[]; readonly model: NonNullable<PortaFactories["model"]>; readonly reportDirectory?: string }

export class LiveQualificationRunner {
  constructor(private readonly options: LiveRunnerOptions) {}
  async runAll(): Promise<readonly QualificationResult[]> { const selected = this.options.fixtures ?? fixtures; const results: QualificationResult[] = []; for (const fixture of selected) results.push(await this.run(fixture)); return results; }
  async run(fixture: FixtureDefinition): Promise<QualificationResult> {
    const budget = { ...defaultBudget, ...this.options.budget }; const started = Date.now(); const instance = fixture.setup(); const trace: string[] = []; const errors: string[] = []; const toolsById: Record<string, number> = {}; let executionCalls = 0; let mutations = 0; let artifactSearches = 0; let artifactReads = 0; let scratchpadReads = 0; let scratchpadWrites = 0; let taskUpdates = 0; let artifactCreated = false; let artifactOffContext = true; let compactions = 0; let toolCalls = 0; let turns = 0; let taskId: string | undefined;
    let observed: ObservedModel | undefined;
    const config = liveConfig(this.options.baseConfig, instance.root, budget);
    const factories: PortaFactories = { model: (modelConfig) => { const provider = this.options.model(modelConfig); observed = new ObservedModel(provider); return observed; }, executionRuntime: new HostProcessRuntime(), executionSandbox: new HostProcessSandbox(), compactor: new DeterministicConversationCompactor() };
    let app: Awaited<ReturnType<typeof createPortaApplication>> | undefined;
    try {
      app = await createPortaApplication(config, factories);
      const sessionId = await createSession(app);
      let stopRun = false;
      for (let turn = 0; turn < budget.maxTurns && !stopRun; turn++) {
        if (Date.now() - started >= budget.maxDurationMs) { errors.push("qualification deadline reached"); break; }
        turns++;
        const input = turn === 0 ? fixture.prompt : "Continue working on the active task. Use the current task state and available tools. Complete it only after required verification is satisfied.";
        const events = app.gateway.execute({ type: "SubmitInput", sessionId, input }, { traceId: `qualification-${fixture.id}`, signal: new AbortController().signal, deadline: started + budget.maxDurationMs });
        for await (const event of events) {
          if (event.type === "ApprovalRequested") { await approve(app, event.approvalId); continue; }
          if (event.type === "ToolRequested") { toolCalls++; trace.push(event.toolId); toolsById[event.toolId] = (toolsById[event.toolId] ?? 0) + 1; if (event.toolId === "execution/run") executionCalls++; if (event.toolId === "filesystem/patch_file" || event.toolId === "filesystem/write_file") mutations++; if (event.toolId === "artifact/search") artifactSearches++; if (event.toolId === "artifact/read") artifactReads++; if (event.toolId === "scratchpad/read" || event.toolId === "scratchpad/search") scratchpadReads++; if (event.toolId === "scratchpad/write") scratchpadWrites++; if (event.toolId === "task/update") taskUpdates++; if (toolCalls > budget.maxToolCalls || executionCalls > budget.maxExecutions || mutations > budget.maxMutations) { errors.push("qualification budget exceeded"); await collect(app.gateway.execute({ type: "CancelExecution", sessionId })); stopRun = true; } }
          if (event.type === "ToolCompleted") { if (event.toolId === "execution/run" && event.result.output && typeof event.result.output === "object" && "stdoutArtifact" in event.result.output) artifactCreated = true; if (event.result.error) errors.push(`${event.result.error.code}: ${event.toolId}`); }
          if (event.type === "Error") errors.push(`${event.error.code}: ${event.error.message}`);
          if (event.type === "ExecutionCancelled") stopRun = true;
        }
        const task = await app.tasks.get(sessionId); if (task) taskId = task.id;
        if (task?.status === "completed") break;
        if (errors.some((error) => error.startsWith("MODEL_FAILED") || error.startsWith("TIMEOUT") || error.startsWith("qualification budget"))) break;
      }
      const task = await app.tasks.get(sessionId); taskId = task?.id; const traceSummary = summarizeToolTrace(trace); const verification = fixture.verify(instance); const taskEvidencePass = Boolean(task && task.criteria.length > 0 && task.criteria.filter((criterion) => criterion.required).every((criterion) => task.evidence.filter((entry) => entry.criterionId === criterion.id).at(-1)?.outcome === "pass")); const final: QualificationFinal = { ...verification, taskCompleted: task?.status === "completed", ...(taskId ? { taskId } : {}), taskEvidencePass, artifactCreated, artifactOffContext: observed ? !observed.fullArtifactVisibleBeforeRead : artifactOffContext };
      if (observed) compactions = observed.requests.filter((request) => request.control?.some((message) => message.content.includes("Conversation history was compacted"))).length;
      const outcome = classify(final, errors, toolCalls > budget.maxToolCalls || executionCalls > budget.maxExecutions || mutations > budget.maxMutations, verification.testsPass && verification.scopeValid && verification.apiUnchanged && verification.testsUnchanged);
      const result: QualificationResult = { fixture: fixture.id, description: fixture.description, model: observed?.descriptor.id ?? "unknown", outcome, budget, metrics: { turns: observed?.requests.length ?? turns, toolCalls: traceSummary.toolCalls, executions: traceSummary.executions, mutations: traceSummary.mutations, gitInspections: (toolsById["git/status"] ?? 0) + (toolsById["git/diff"] ?? 0) + (toolsById["git/show"] ?? 0) + (toolsById["git/log"] ?? 0), artifactSearches, artifactReads, scratchpadReads, scratchpadWrites, taskUpdates, compactions, durationMs: Date.now() - started, toolsById: traceSummary.toolsById }, final, trace, errors: errors.slice(-20) };
      if (this.options.reportDirectory) writeResult(this.options.reportDirectory, result);
      return result;
    } catch (error) { errors.push(error instanceof Error ? error.message : "qualification failed"); const verification = fixture.verify(instance); const result: QualificationResult = { fixture: fixture.id, description: fixture.description, model: observed?.descriptor.id ?? "unknown", outcome: "model-error", budget, metrics: { turns: observed?.requests.length ?? turns, toolCalls, executions: executionCalls, mutations, gitInspections: 0, artifactSearches, artifactReads, scratchpadReads, scratchpadWrites, taskUpdates, compactions, durationMs: Date.now() - started, toolsById }, final: { ...verification, taskCompleted: false, ...(taskId ? { taskId } : {}), taskEvidencePass: false, artifactCreated, artifactOffContext }, trace, errors }; if (this.options.reportDirectory) writeResult(this.options.reportDirectory, result); return result;
    } finally { await app?.shutdown(); }
  }
}

function liveConfig(base: PortaConfig, root: string, budget: QualificationBudget): PortaConfig { return parsePortaConfig({ ...base, tools: [], filesystem: { root, maxExactContextBytes: 16 * 1024, maxReadBytes: 2 * 1024 * 1024, mutation: { enabled: true } }, execution: { enabled: true, allowedCommands: [process.execPath, "node"], maxStdoutBytes: 256, maxStderrBytes: 256, defaultTimeoutMs: 10_000, filesystem: "best-effort", network: "best-effort", codeLoading: "best-effort", sandbox: { preference: ["sandbox.host-process"] } }, git: { enabled: true, maxDiffBytes: 64 * 1024 }, authorization: { mode: "require-approval" }, agent: { maxSteps: 16, maxToolCalls: budget.maxToolCalls }, conversation: { maxTurns: 6, compaction: { enabled: true, keepRecentTurns: 2, maxManifestEntries: 20 } }, persistence: undefined }); }
async function createSession(app: Awaited<ReturnType<typeof createPortaApplication>>): Promise<string> { for await (const event of app.gateway.execute({ type: "CreateSession" })) if (event.type === "SessionCreated") return event.sessionId; throw new Error("session creation failed"); }
async function approve(app: Awaited<ReturnType<typeof createPortaApplication>>, approvalId: string): Promise<void> { await collect(app.gateway.execute({ type: "ResolveApproval", approvalId, decision: "approve" })); }
async function collect(source: AsyncIterable<unknown>): Promise<void> { for await (const _ of source) { /* approval resolution is intentionally observed through the normal gateway */ } }
export function classify(final: QualificationFinal, errors: readonly string[], budgetExceeded: boolean, repoCorrect: boolean): QualificationOutcome { if (budgetExceeded) return "budget-exhausted"; if (errors.some((error) => error.startsWith("MODEL_FAILED") || error.startsWith("CAPABILITY_UNAVAILABLE"))) return "model-error"; if (errors.some((error) => error.startsWith("TOOL_FAILED") || error.startsWith("RUNTIME_FAILED") || error.startsWith("SANDBOX_FAILED"))) return "tool-error"; if (errors.some((error) => error.includes("POLICY_VIOLATION: task/update"))) return "invalid-completion"; if (errors.some((error) => error.startsWith("POLICY_VIOLATION") || error.startsWith("AUTHORIZATION_DENIED"))) return "policy-denied"; if (!repoCorrect) return final.scopeValid ? "verification-failed" : "scope-violation"; if (!final.taskCompleted || !final.taskEvidencePass) return "repo-fixed-but-task-incomplete"; return "success"; }
function writeResult(directory: string, result: QualificationResult): void { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, `${result.fixture}.json`), `${JSON.stringify(result, null, 2)}\n`); }
export function markdownSummary(results: readonly QualificationResult[]): string { const lines = ["Fixture | Outcome | Turns | Tools | Exec | Mutations | Artifacts | Task", "--- | --- | ---: | ---: | ---: | ---: | ---: | ---"]; for (const result of results) lines.push(`${result.fixture} | ${result.outcome} | ${result.metrics.turns} | ${result.metrics.toolCalls} | ${result.metrics.executions} | ${result.metrics.mutations} | ${result.metrics.artifactReads} | ${result.final.taskCompleted ? "PASS" : "FAIL"}`); return `${lines.join("\n")}\n`; }