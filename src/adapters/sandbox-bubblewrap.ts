import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ExecutionPolicy, HarnessPlugin, SandboxBinding, SandboxCapabilities, SandboxProvider, SandboxSession, failure } from "../contracts.js";
import { executionId } from "../runtime.js";
import { processWrapperBindingKind, ProcessWrapperPayload } from "../process-wrapper.js";

export interface BubblewrapSandboxConfig { readonly executable?: string; readonly workspaceRoot: string }
export const bubblewrapSandboxConfigSchema = z.object({ executable: z.string().min(1).optional(), workspaceRoot: z.string().min(1) });

class BubblewrapSession implements SandboxSession {
  readonly id = executionId();
  constructor(readonly binding: SandboxBinding) {}
  async dispose(): Promise<void> {}
}

/** Optional Linux namespace sandbox. It uses direct argv and never invokes a shell. */
export class BubblewrapSandbox implements SandboxProvider {
  readonly descriptor = { id: "sandbox.linux-bubblewrap", version: "1" };
  readonly capabilities: SandboxCapabilities = { filesystem: "external", network: "external", codeLoading: "unsupported" };
  private readonly executable: string;
  private readonly workspaceRoot: string;
  constructor(config: BubblewrapSandboxConfig) { const parsed = bubblewrapSandboxConfigSchema.parse(config); this.executable = parsed.executable ?? "bwrap"; this.workspaceRoot = parsed.workspaceRoot; }
  async available(): Promise<boolean> { return this.findExecutable() !== undefined && spawnSync(this.findExecutable()!, ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore", timeout: 1000 }).status === 0; }
  async create(policy: ExecutionPolicy): Promise<SandboxSession> {
    const executable = this.findExecutable();
    if (!executable || !(await this.available())) throw failure("CAPABILITY_UNAVAILABLE", "Bubblewrap is unavailable or cannot create an unprivileged sandbox.");
    // Never expose the host root read-only: that still leaks arbitrary host files such as
    // /etc/hostname. Build a minimal runtime view, then mount only the granted workspace.
    const argsPrefix = [...buildBubblewrapArgs(this.workspaceRoot, policy)];
    const payload: ProcessWrapperPayload = { wrapperExecutable: executable, argsPrefix, cwdFlag: "--chdir" };
    return new BubblewrapSession({ schemaVersion: 1, kind: processWrapperBindingKind, payload });
  }
  private findExecutable(): string | undefined { if (this.executable.includes("/")) return existsSync(this.executable) ? this.executable : undefined; for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) { const candidate = join(directory, this.executable); try { accessSync(candidate, constants.X_OK); return candidate; } catch {} } return undefined; }
}
export function buildBubblewrapArgs(workspaceRoot: string, policy: ExecutionPolicy): readonly string[] {
  const argsPrefix: string[] = ["--die-with-parent", "--new-session", "--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  // Keep the host runtime libraries available, but mask common host-data roots.
  for (const path of ["/etc", "/root", "/var", "/run", "/opt", "/srv", "/mnt", "/media"]) if (existsSync(path)) argsPrefix.push("--tmpfs", path);
  if (policy.network === "deny") argsPrefix.push("--unshare-net");
  const parentParts = workspaceRoot.split("/").filter(Boolean);
  let current = "";
  for (const part of parentParts) { current += `/${part}`; if (current !== workspaceRoot && current !== "/tmp") argsPrefix.push("--dir", current); }
  if (workspaceRoot !== "/tmp") argsPrefix.push("--dir", workspaceRoot);
  argsPrefix.push(policy.filesystem === "deny" ? "--tmpfs" : "--bind", workspaceRoot, workspaceRoot);
  return argsPrefix;
}
export function bubblewrapSandboxPlugin(sandbox: BubblewrapSandbox): HarnessPlugin { return { manifest: { schemaVersion: 1, id: "sandbox.linux-bubblewrap", version: "1", provides: [{ id: "sandbox.filesystem", version: "1" }, { id: "sandbox.network", version: "1" }], requires: [] }, register(registrar) { registrar.provide({ id: "sandbox.filesystem", version: "1" }, sandbox); registrar.provide({ id: "sandbox.network", version: "1" }, sandbox); } }; }
