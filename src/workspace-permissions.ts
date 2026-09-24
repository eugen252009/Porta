import { promises as fs } from "node:fs";
import { relative, sep } from "node:path";
import type { ToolAuthorizationPolicy, ToolAuthorizationRequest, ToolAuthorizationDecision } from "./contracts.js";
import { failure } from "./contracts.js";
import { WorkspaceBoundary } from "./workspace.js";

const sensitiveDirectories = new Set([
  ".git", ".porta", ".auth", ".cocoindex_code", ".ssh", ".aws", ".azure", ".gcloud", ".kube", ".docker", ".gnupg", ".config", "secrets", ".secrets",
]);
const sensitiveNames = new Set([
  ".netrc", ".npmrc", ".pypirc", "credentials", "credentials.json", "credentials.yaml", "credentials.yml",
  "auth.json", "oauth.json", "tokens.json", "webauthn.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "kubeconfig",
]);

/** Conservative name-based policy, not a secret-content detector or OS sandbox. */
export class WorkspaceFileAccess {
  readonly boundary: WorkspaceBoundary;
  private readonly additional: readonly string[];
  constructor(root: string, sensitivePaths: readonly string[] = []) {
    this.boundary = new WorkspaceBoundary(root);
    this.additional = sensitivePaths.map((path) => {
      if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw failure("VALIDATION_FAILED", "Sensitive paths must be relative workspace paths without traversal.");
      return path.toLowerCase();
    });
  }
  isSensitive(path: string): boolean {
    const normalized = path.split(sep).join("/").toLowerCase();
    if (this.additional.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`))) return true;
    return normalized.split("/").some((part) => sensitiveDirectories.has(part) || sensitiveNames.has(part) || part.startsWith(".env") || /\.(?:key|pem|p12|pfx|keystore|db(?:-wal|-shm)?|sqlite(?:3)?(?:-wal|-shm)?)$/.test(part) || /^(?:secrets?|credentials?)(?:[._-]|$)/.test(part));
  }
  async resolve(path: string): Promise<{ path: string; exists: boolean; sensitive: boolean }> {
    // Reuse mutation confinement even for reads: no symlinks in any path component.
    const target = await this.boundary.resolveMutation(path);
    if (target.exists) {
      const stat = await fs.lstat(target.path);
      if ((!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1)) throw failure("POLICY_VIOLATION", "Special files and hard-linked files are not accessible in workspace permission mode.");
    }
    return { ...target, sensitive: this.isSensitive(relative(this.boundary.root, target.path)) };
  }
}

/** Everything except the six explicitly classified filesystem operations requires approval. */
export class WorkspaceToolAuthorizationPolicy implements ToolAuthorizationPolicy {
  constructor(private readonly files: WorkspaceFileAccess) {}
  async authorize(request: ToolAuthorizationRequest): Promise<ToolAuthorizationDecision> {
    if (request.context.signal.aborted || (request.context.deadline !== undefined && Date.now() >= request.context.deadline)) return "deny";
    if (request.invocation.toolId === "filesystem/search") return "allow"; // Provider searches only the filtered source.
    const capabilities = request.descriptor?.capabilities ?? [];
    if (capabilities.includes("scratchpad.read") || capabilities.includes("scratchpad.write") || request.invocation.toolId.startsWith("scratchpad/")) return "allow"; // Session-local durable notes are not an external side effect.
    if (capabilities.includes("task.read") || capabilities.includes("task.write") || capabilities.includes("artifact.read") || capabilities.includes("artifact.write") || request.invocation.toolId.startsWith("task/") || request.invocation.toolId.startsWith("artifact/")) return "allow"; // Session-local state remains policy-bound by its provider.
    if (capabilities.some((capability) => capability === "network.access" || capability.startsWith("network."))) return "require-approval";
    if (!["filesystem/read_file", "filesystem/list_directory", "filesystem/stat", "filesystem/write_file", "filesystem/patch_file"].includes(request.invocation.toolId)) return "require-approval";
    const input = request.invocation.input;
    if (!input || typeof input !== "object" || Array.isArray(input) || !("path" in input) || typeof input.path !== "string") return "deny";
    try { return (await this.files.resolve(input.path)).sensitive ? "require-approval" : "allow"; }
    catch { return "deny"; }
  }
}
