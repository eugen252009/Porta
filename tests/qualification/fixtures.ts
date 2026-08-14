import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface FixtureVerification {
  testsPass: boolean;
  scopeValid: boolean;
  apiUnchanged: boolean;
  testsUnchanged: boolean;
  changedFiles: readonly string[];
  details?: string;
}

export interface FixtureInstance {
  readonly root: string;
  readonly baselineTestHashes: Readonly<Record<string, string>>;
  readonly baselineApiKeys: readonly string[];
}

export interface FixtureDefinition {
  readonly id: string;
  readonly description: string;
  readonly prompt: string;
  readonly allowedChangedFiles: readonly string[];
  readonly setup: () => FixtureInstance;
  readonly verify: (fixture: FixtureInstance) => FixtureVerification;
}

function hash(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function git(root: string, args: readonly string[]): string { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }); }
function nodeKeys(root: string, path: string): readonly string[] { const value = execFileSync(process.execPath, ["-e", `console.log(JSON.stringify(Object.keys(require(${JSON.stringify(join(root, path))})).sort()))`], { encoding: "utf8" }); return JSON.parse(value) as string[]; }
function setupRepository(files: Readonly<Record<string, string>>, apiPath: string, testPaths: readonly string[]): FixtureInstance {
  const root = mkdtempSync(join(tmpdir(), "porta-live-"));
  for (const [path, content] of Object.entries(files)) { const target = join(root, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, content); }
  git(root, ["init", "-q"]); git(root, ["config", "user.email", "porta-live@example.invalid"]); git(root, ["config", "user.name", "Porta live qualification"]); git(root, ["add", "."]); git(root, ["commit", "-qm", "broken fixture"]);
  return { root, baselineTestHashes: Object.fromEntries(testPaths.map((path) => [path, hash(join(root, path))])), baselineApiKeys: nodeKeys(root, apiPath) };
}
function changed(root: string): readonly string[] { return git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean).sort(); }
function testsPass(root: string): boolean { try { execFileSync(process.execPath, ["--test"], { cwd: root, stdio: "pipe" }); return true; } catch { return false; } }
function verify(fixture: FixtureInstance, allowed: readonly string[]): FixtureVerification {
  const files = changed(fixture.root); const testsUnchanged = Object.entries(fixture.baselineTestHashes).every(([path, expected]) => hash(join(fixture.root, path)) === expected);
  const apiUnchanged = JSON.stringify(nodeKeys(fixture.root, "src/index.js")) === JSON.stringify(fixture.baselineApiKeys);
  return { testsPass: testsPass(fixture.root), scopeValid: files.every((path) => allowed.includes(path)), apiUnchanged, testsUnchanged, changedFiles: files };
}

const rangeFiles = {
  "src/range.js": "function clamp(value, min, max) {\n  return Math.max(min, Math.min(min, value));\n}\nmodule.exports = { clamp };\n",
  "src/index.js": "module.exports = require('./range.js');\n",
  "test/range.test.js": "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { clamp } = require('../src/index.js');\ntest('clamps to the upper bound', () => assert.equal(clamp(9, 0, 5), 5));\ntest('clamps to the lower bound', () => assert.equal(clamp(-2, 0, 5), 0));\n",
};
const crossFiles = {
  "src/parser.js": "module.exports = function parseIdentifier(value) { return String(value); };\n",
  "src/normalize.js": "function normalizeIdentifier(value) { return String(value).toLowerCase(); }\nmodule.exports = { normalizeIdentifier };\n",
  "src/formatter.js": "module.exports = function formatIdentifier(value) { return `[${value}]`; };\n",
  "src/index.js": "module.exports = { ...require('./parser.js'), ...require('./normalize.js'), formatIdentifier: require('./formatter.js') };\n",
  "test/behavior.test.js": "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { normalizeIdentifier } = require('../src/index.js');\ntest('normalizes trailing whitespace without changing case', () => assert.equal(normalizeIdentifier('Porta  '), 'Porta'));\n",
};
const artifactFiles = {
  "src/range.js": "function normalizeRange(value, min, max) {\n  const lower = Math.max(min, value);\n  return { min: lower, max: lower };\n}\nmodule.exports = { normalizeRange };\n",
  "src/index.js": "module.exports = require('./range.js');\n",
  "test/diagnostic.test.js": "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { normalizeRange } = require('../src/index.js');\ntest('normalizes a range', () => {\n  for (let i = 0; i < 140; i++) console.log(`diagnostic-${i}`);\n  console.log('ROOT_CAUSE_CODE=RANGE_UPPER_BOUND');\n  assert.deepEqual(normalizeRange(3, 0, 5), { min: 0, max: 5 });\n});\n",
};

export const fixtures: readonly FixtureDefinition[] = [
  { id: "localized-bug", description: "A localized boundary-condition implementation bug.", prompt: "Fix the range normalization bug in this repository. Keep the public API unchanged, do not modify tests, modify only the necessary source file, run the existing tests, inspect Git changes, and record passing verification evidence before completing the task.", allowedChangedFiles: ["src/range.js"], setup: () => setupRepository(rangeFiles, "src/index.js", ["test/range.test.js"]), verify: (fixture) => verify(fixture, ["src/range.js"]) },
  { id: "cross-file-discovery", description: "A behavior bug whose implementation is discoverable across several source files.", prompt: "Fix the bug where normalized identifiers retain trailing whitespace. Preserve the public API, do not modify tests, discover the relevant implementation in the repository, run the existing tests, inspect Git changes, and record passing verification evidence before completing the task.", allowedChangedFiles: ["src/normalize.js"], setup: () => setupRepository(crossFiles, "src/index.js", ["test/behavior.test.js"]), verify: (fixture) => verify(fixture, ["src/normalize.js"]) },
  { id: "large-diagnostic-artifact", description: "A failing test with a bounded diagnostic and a retained artifact.", prompt: "Fix the range normalization failure in this repository. Preserve the public API and do not modify tests. Run the existing tests and investigate the complete diagnostic when the visible output is truncated; use available artifact tools when needed. Inspect Git changes and record passing verification evidence before completing the task.", allowedChangedFiles: ["src/range.js"], setup: () => setupRepository(artifactFiles, "src/index.js", ["test/diagnostic.test.js"]), verify: (fixture) => verify(fixture, ["src/range.js"]) },
];
