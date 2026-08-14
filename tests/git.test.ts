import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliGitBackend, GitBackend, GitToolProvider } from "../src/git.js";
import { FilesystemToolProvider } from "../src/filesystem.js";
import { contentHash } from "../src/mutation.js";
import { ToolContext, ToolInvocation } from "../src/contracts.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const context = (sessionId = "git-session"): ToolContext => ({ traceId: "trace", sessionId, executionId: "execution", signal: new AbortController().signal });
const invoke = (toolId: string, input: unknown): ToolInvocation => ({ schemaVersion: 1, requestId: toolId, toolId, input: input as never });
function repo() { const root = mkdtempSync(join(tmpdir(), "porta-git-")); execFileSync("git", ["init", "-q", root]); execFileSync("git", ["-C", root, "config", "user.email", "porta@example.invalid"]); execFileSync("git", ["-C", root, "config", "user.name", "Porta Test"]); writeFileSync(join(root, "file.txt"), "old\n"); execFileSync("git", ["-C", root, "add", "--", "file.txt"]); execFileSync("git", ["-C", root, "commit", "-qm", "baseline"]); return root; }

describe("Git capability", () => {
  it("validates structured fake backend results without CLI dependence", async () => { const backend: GitBackend = { repositoryRoot: "/workspace", async status() { return { branch: "main", detached: false, clean: false, staged: [], unstaged: ["file.txt"], untracked: [], conflicts: [], truncated: false }; }, async diff() { return { mode: "working-tree", filesChanged: 1, insertions: 1, deletions: 1, patch: "-old\n+new", truncated: false }; }, async show() { return { revision: "HEAD", hash: "abc", patch: "", truncated: false }; }, async log() { return { entries: [], truncated: false }; } }; const provider = new GitToolProvider(backend); expect((await provider.invoke(invoke("status", {}), context())).output).toMatchObject({ branch: "main", unstaged: ["file.txt"] }); expect((await provider.invoke(invoke("diff", {}), context())).output).toMatchObject({ filesChanged: 1, patch: "-old\n+new" }); });

  it.skipIf(!gitAvailable)("observes clean, modified, untracked, detached, diff, show, and log states", async () => { const root = repo(); const backend = new CliGitBackend({ root }); expect(await backend.available!()).toBe(true); expect(await backend.status(context())).toMatchObject({ clean: true, staged: [], unstaged: [], untracked: [] }); expect((await backend.status(context())).branch).toEqual(expect.any(String)); writeFileSync(join(root, "file.txt"), "new\n"); writeFileSync(join(root, "untracked.txt"), "u\n"); const status = await backend.status(context()); expect(status).toMatchObject({ clean: false, unstaged: ["file.txt"], untracked: ["untracked.txt"] }); const diff = await backend.diff({}, context()); expect(diff).toMatchObject({ filesChanged: 1, insertions: 1, deletions: 1, truncated: false }); expect(diff.patch).toContain("-old"); expect(diff.patch).toContain("+new"); expect((await backend.show({ revision: "HEAD" }, context())).subject).toBe("baseline"); expect((await backend.log({ limit: 5 }, context())).entries[0]?.subject).toBe("baseline"); execFileSync("git", ["-C", root, "checkout", "-q", "--detach", "HEAD"]); expect((await backend.status(context())).detached).toBe(true); });

  it.skipIf(!gitAvailable)("composes filesystem patch with git status and diff", async () => { const root = repo(); const filesystem = new FilesystemToolProvider({ root, mutation: { enabled: true } }); const before = contentHash(Buffer.from("old\n")); const patched = await filesystem.invoke(invoke("patch_file", { path: "file.txt", expectedHash: before, edits: [{ oldText: "old", newText: "new" }] }), context()); expect(patched.ok).toBe(true); const backend = new CliGitBackend({ root }); expect((await backend.status(context())).unstaged).toEqual(["file.txt"]); expect((await backend.diff({ path: "file.txt" }, context())).patch).toContain("+new"); });

  it.skipIf(!gitAvailable)("bounds diffs, rejects path escapes, and treats revisions as literal argv", async () => { const root = repo(); writeFileSync(join(root, "file.txt"), "x".repeat(1000)); const backend = new CliGitBackend({ root, maxDiffBytes: 64 }); const diff = await backend.diff({}, context()); expect(diff.truncated).toBe(true); await expect(backend.diff({ path: "../outside" }, context())).rejects.toMatchObject({ error: { code: "CAPABILITY_UNAVAILABLE" } }); const sentinel = join(root, "sentinel"); await expect(backend.show({ revision: `; touch ${sentinel}` }, context())).rejects.toBeTruthy(); expect(() => readFileSync(sentinel)).toThrow(); });

  it.skipIf(!gitAvailable)("returns an empty log for an initialized empty repository", async () => { const root = mkdtempSync(join(tmpdir(), "porta-empty-git-")); execFileSync("git", ["init", "-q", root]); const backend = new CliGitBackend({ root }); expect(await backend.available!()).toBe(true); expect((await backend.log({}, context())).entries).toEqual([]); });
});
