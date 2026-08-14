import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtures } from "./qualification/fixtures.js";
import { budgetExceeded, classify, defaultBudget, markdownSummary, QualificationFinal, QualificationResult, summarizeToolTrace } from "./qualification/live-runner.js";

const localized = fixtures.find((fixture) => fixture.id === "localized-bug")!;

describe("live qualification infrastructure", () => {
  it("creates a clean broken fixture and repeatable baseline", () => {
    const first = localized.setup(); const second = localized.setup();
    expect(first.baselineTestHashes).toEqual(second.baselineTestHashes);
    expect(first.baselineApiKeys).toEqual(second.baselineApiKeys);
  });

  it("detects a successful fix, test edits, and extra files", () => {
    const fixed = localized.setup(); writeFileSync(join(fixed.root, "src/range.js"), "function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }\nmodule.exports = { clamp };\n");
    expect(localized.verify(fixed)).toMatchObject({ testsPass: true, scopeValid: true, apiUnchanged: true, testsUnchanged: true });
    const testChanged = localized.setup(); writeFileSync(join(testChanged.root, "test/range.test.js"), "changed\n"); expect(localized.verify(testChanged).testsUnchanged).toBe(false);
    const extra = localized.setup(); mkdirSync(join(extra.root, "notes")); writeFileSync(join(extra.root, "notes", "unexpected.txt"), "not allowed\n"); expect(localized.verify(extra).scopeValid).toBe(false);
  });

  it("classifies incomplete, budget, scope, and successful outcomes", () => {
    const final: QualificationFinal = { testsPass: true, scopeValid: true, apiUnchanged: true, testsUnchanged: true, changedFiles: ["src/range.js"], taskCompleted: false, taskEvidencePass: false, artifactCreated: false, artifactOffContext: true };
    expect(classify(final, [], false, true)).toBe("repo-fixed-but-task-incomplete");
    expect(classify(final, [], true, true)).toBe("budget-exhausted");
    expect(classify(final, ["POLICY_VIOLATION: task/update"], false, true)).toBe("invalid-completion");
    expect(classify({ ...final, scopeValid: false }, [], false, false)).toBe("scope-violation");
    expect(classify({ ...final, taskCompleted: true, taskEvidencePass: true }, [], false, true)).toBe("success");
  });

  it("keeps budgets explicit and serializes machine-readable reports", () => {
    expect(summarizeToolTrace(["filesystem/search", "execution/run", "filesystem/patch_file", "git/status"])).toEqual({ toolCalls: 4, executions: 1, mutations: 1, toolsById: { "filesystem/search": 1, "execution/run": 1, "filesystem/patch_file": 1, "git/status": 1 } }); expect(defaultBudget).toMatchObject({ maxTurns: 20, maxToolCalls: 60, maxExecutions: 6, maxMutations: 6 }); expect(budgetExceeded({ toolCalls: 61, executions: 0, mutations: 0 }, defaultBudget)).toBe(true); expect(budgetExceeded({ toolCalls: 60, executions: 6, mutations: 6 }, defaultBudget)).toBe(false);
    const result: QualificationResult = { fixture: "localized-bug", description: "fixture", model: "fake", outcome: "success", budget: defaultBudget, metrics: { turns: 2, toolCalls: 4, executions: 1, mutations: 1, gitInspections: 1, artifactSearches: 0, artifactReads: 0, scratchpadReads: 0, scratchpadWrites: 0, taskUpdates: 2, compactions: 0, durationMs: 10, toolsById: { "task/update": 2 } }, final: { testsPass: true, scopeValid: true, apiUnchanged: true, testsUnchanged: true, changedFiles: ["src/range.js"], taskCompleted: true, taskEvidencePass: true, artifactCreated: false, artifactOffContext: true }, trace: ["task/create", "task/update"], errors: [] };
    expect(JSON.parse(JSON.stringify(result)).outcome).toBe("success"); expect(markdownSummary([result])).toContain("localized-bug | success | 2 | 4");
  });
});
