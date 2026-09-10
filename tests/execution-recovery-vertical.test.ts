import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqlitePersistence } from "../src/persistence-sqlite.js";
import { InteractiveApprovalGateway } from "../src/application-gateway.js";
import { PendingApprovalProvider } from "../src/approval-pending.js";
import { ScriptedToolModelProvider } from "../src/agent-mocks.js";
import { StaticToolAuthorizationPolicy } from "../src/authorization-mocks.js";
import { MockToolProvider } from "../src/tool-mocks.js";
import { ToolRouter } from "../src/tools.js";
import { ToolContext } from "../src/contracts.js";
import { MemoryExecutionPersistence } from "../src/execution-persistence.js";
import type { DurableExecution } from "../src/execution-persistence.js";

const context: ToolContext = { traceId: "trace", sessionId: "session", executionId: "execution", signal: new AbortController().signal };
const db = () => join(mkdtempSync(join(tmpdir(), "porta-recovery-")), "porta.db");
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }
async function until<T extends { type: string }>(iterator: AsyncIterator<T>, type: string): Promise<T> { for (;;) { const next = await iterator.next(); if (next.done) throw new Error(`missing ${type}`); if (next.value.type === type) return next.value; } }

it("recovers an approval-blocked execution from SQLite and continues without regenerating the call", async () => {
  const persistence = await openSqlitePersistence(db());
  await persistence.conversations.createSession({ schemaVersion: 1, id: "session-recovery", state: "open", createdAt: new Date().toISOString(), history: [], turns: [] });
  expect((await persistence.conversations.getSession("session-recovery"))?.state).toBe("open");
  const tools = new ToolRouter(); const tool = new MockToolProvider("provider"); await tools.register("provider", tool, context);
  const model = new ScriptedToolModelProvider([[{ type: "tool", id: "stable-call", toolId: "provider/echo", input: { value: "RECOVERY_TOOL_OK" } }], [{ type: "text", text: "completed after recovery" }]]);
  const firstPending = new PendingApprovalProvider(persistence.approvals);
  const first = new InteractiveApprovalGateway(model, tools, firstPending, new StaticToolAuthorizationPolicy("require-approval"), undefined, persistence.conversations, {}, undefined, persistence.executions);
  const stream = first.execute({ type: "SubmitInput", sessionId: "session-recovery", input: "run recovery" }); const iterator = stream[Symbol.asyncIterator]();
  const approval = await until(iterator, "ApprovalRequested") as { approvalId: string };
  const before = persistence.executions.listIncomplete()[0]!;
  expect(before.phase).toBe("approval_required"); expect(before.currentToolCall?.id).toBe("stable-call"); expect(model.turns).toBe(1); expect(tool.calls).toHaveLength(0);

  const secondPending = new PendingApprovalProvider(persistence.approvals);
  new InteractiveApprovalGateway(model, tools, secondPending, new StaticToolAuthorizationPolicy("require-approval"), undefined, persistence.conversations, {}, undefined, persistence.executions);
  const thirdPending = new PendingApprovalProvider(persistence.approvals);
  const third = new InteractiveApprovalGateway(model, tools, thirdPending, new StaticToolAuthorizationPolicy("require-approval"), undefined, persistence.conversations, {}, undefined, persistence.executions);
  expect(secondPending.pendingRequests().map((entry) => entry.approvalId)).toEqual([approval.approvalId]); expect(thirdPending.pendingRequests().map((entry) => entry.approvalId)).toEqual([approval.approvalId]);
  await collect(third.execute({ type: "ResolveApproval", approvalId: approval.approvalId, decision: "approve" }));
  for (let i = 0; i < 50 && tool.calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(tool.calls).toHaveLength(1);
  for (let i = 0; i < 50 && persistence.executions.get(before.executionId)?.phase !== "completed"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const execution = persistence.executions.get(before.executionId);
  expect(execution?.phase).toBe("completed"); expect(execution?.currentToolCall?.id).toBe("stable-call"); expect(model.turns).toBe(2);
  const session = await persistence.conversations.getSession("session-recovery"); expect(session?.history.filter((message) => message.role === "tool")).toHaveLength(1);
  await iterator.return?.(); persistence.close();
});

it("rejects and cancels restored approval checkpoints without invoking the tool", async () => {
  const persistence = await openSqlitePersistence(db()); const sessionId = "session-reject-cancel"; await persistence.conversations.createSession({ schemaVersion: 1, id: sessionId, state: "open", createdAt: new Date().toISOString(), history: [], turns: [] }); const now = new Date().toISOString(); const state: DurableExecution = { executionId: "execution-reject-cancel", sessionId, traceId: "trace", phase: "approval_required", version: 1, input: "input", history: [{ role: "user", content: "input" }], currentToolCall: { id: "stable-call", toolId: "provider/echo", input: { value: "x" } }, approvalId: "approval-reject-cancel", createdAt: now, updatedAt: now }; persistence.executions.save(state); persistence.approvals.save({ type: "ApprovalRequested", approvalId: state.approvalId!, toolCallId: "stable-call", toolId: "provider/echo", input: { value: "x" }, executionId: state.executionId, sessionId, traceId: "trace" }); const tools = new ToolRouter(); const tool = new MockToolProvider("provider"); await tools.register("provider", tool, context); const pending = new PendingApprovalProvider(persistence.approvals); const gateway = new InteractiveApprovalGateway(new ScriptedToolModelProvider([]), tools, pending, new StaticToolAuthorizationPolicy("require-approval"), undefined, persistence.conversations, {}, undefined, persistence.executions); await collect(gateway.execute({ type: "ResolveApproval", approvalId: state.approvalId!, decision: "deny" })); expect(persistence.executions.get(state.executionId)?.phase).toBe("failed"); expect(tool.calls).toHaveLength(0); const failed = persistence.executions.get(state.executionId)!; const cancelled = { ...failed, phase: "approval_required" as const, approvalId: "approval-cancel", version: failed.version + 1, updatedAt: new Date().toISOString() }; persistence.executions.save(cancelled, failed.version); persistence.approvals.save({ type: "ApprovalRequested", approvalId: "approval-cancel", toolCallId: "stable-call", toolId: "provider/echo", input: { value: "x" }, executionId: state.executionId, sessionId, traceId: "trace" }); const pendingCancel = new PendingApprovalProvider(persistence.approvals); new InteractiveApprovalGateway(new ScriptedToolModelProvider([]), tools, pendingCancel, new StaticToolAuthorizationPolicy("require-approval"), undefined, persistence.conversations, {}, undefined, persistence.executions); pendingCancel.cancelSession(sessionId); expect(pendingCancel.pendingCount).toBe(0); expect(persistence.executions.get(state.executionId)?.phase).toBe("cancelled"); expect(tool.calls).toHaveLength(0); persistence.close();
});

it("allows only one stale-safe continuation claimant", () => { const store = new MemoryExecutionPersistence(); const now = new Date().toISOString(); const state: DurableExecution = { executionId: "cas-execution", sessionId: "cas-session", traceId: "trace", phase: "approval_required", version: 1, input: "input", history: [], currentToolCall: { id: "call", toolId: "tool", input: {} }, approvalId: "approval", createdAt: now, updatedAt: now }; store.save(state); const next = { ...state, phase: "tool_authorized" as const, version: 2, updatedAt: now }; store.save(next, 1); expect(() => store.save({ ...state, phase: "tool_authorized", version: 2, updatedAt: now }, 1)).toThrow(); expect(store.get(state.executionId)?.version).toBe(2); });
