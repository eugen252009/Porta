import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { failure } from "./contracts.js";

export class WorkspaceBoundary {
  readonly root: string;
  constructor(root: string) { this.root = realpathSync(resolve(root)); }
  async resolveRead(requested: string): Promise<string> {
    const candidate = this.lexical(requested); let target: string;
    try { target = await fs.realpath(candidate); } catch { throw failure("CAPABILITY_UNAVAILABLE", "Filesystem path does not exist or cannot be resolved."); }
    if (!inside(this.root, target)) throw failure("CAPABILITY_UNAVAILABLE", "Resolved path is outside the configured filesystem root.");
    return target;
  }
  async resolveMutation(requested: string): Promise<{ path: string; exists: boolean }> {
    const candidate = this.lexical(requested); await this.ensureNoSymlinkAncestors(candidate);
    try {
      const link = await fs.lstat(candidate); if (link.isSymbolicLink()) throw failure("CAPABILITY_UNAVAILABLE", "Mutation through symlinks is not allowed.");
      const target = await fs.realpath(candidate); if (!inside(this.root, target)) throw failure("CAPABILITY_UNAVAILABLE", "Resolved path is outside the configured filesystem root.");
      return { path: target, exists: true };
    } catch (error) {
      if (error instanceof Error && "error" in error) throw error;
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw failure("CAPABILITY_UNAVAILABLE", "Filesystem path cannot be resolved for mutation.");
      const parent = await fs.realpath(resolve(candidate, "..")); if (!inside(this.root, parent)) throw failure("CAPABILITY_UNAVAILABLE", "Mutation path is outside the configured filesystem root.");
      return { path: candidate, exists: false };
    }
  }
  private async ensureNoSymlinkAncestors(candidate: string): Promise<void> { const path = relative(this.root, candidate); let current = this.root; for (const part of path ? path.split(sep) : []) { current = resolve(current, part); try { if ((await fs.lstat(current)).isSymbolicLink()) throw failure("CAPABILITY_UNAVAILABLE", "Mutation through symlinks is not allowed."); } catch (error) { if (error instanceof Error && "error" in error) throw error; if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; break; } } }
  private lexical(requested: string): string { if (!requested || isAbsolute(requested)) throw failure("CAPABILITY_UNAVAILABLE", "Absolute filesystem paths are not allowed."); const candidate = resolve(this.root, requested); if (!inside(this.root, candidate)) throw failure("CAPABILITY_UNAVAILABLE", "Path is outside the configured filesystem root."); return candidate; }
}
function inside(root: string, target: string): boolean { const path = relative(root, target); return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)); }
