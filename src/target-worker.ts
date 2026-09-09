import { platform } from "node:os";
import { promises as fs } from "node:fs";
import { FilesystemToolProvider } from "./filesystem.js";
import { ExecutionToolProvider } from "./execution.js";
import { HostProcessRuntime } from "./adapters/runtime-host-process.js";
import { HostProcessSandbox } from "./adapters/sandbox-host-process.js";
import { InstanceIdentityStore } from "./identity.js";
import { WorkspaceBoundary } from "./workspace.js";
import { createTargetTransportServer, TargetDescription, ToolProviderTargetTransport } from "./target-transport.js";

export interface TargetWorkerOptions {
  readonly targetId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly identityDirectory: string;
  readonly allowedClientIdentities: readonly { readonly identity: string; readonly publicKey: string; readonly algorithm: "ed25519" }[];
  readonly allowedCommands?: readonly string[];
  readonly host?: string;
  readonly port?: number;
}

/** Composes the existing filesystem/runtime providers behind the target transport. */
export async function startTargetWorker(options: TargetWorkerOptions) {
  const filesystem = new FilesystemToolProvider({ root: options.workspaceRoot, mutation: { enabled: true } });
  const execution = new ExecutionToolProvider(new HostProcessRuntime(), new HostProcessSandbox(), { workspaceRoot: options.workspaceRoot, allowedCommands: options.allowedCommands ?? ["node", "npm", "git", "docker"], defaultTimeoutMs: 120_000, maxStdoutBytes: 262_144, maxStderrBytes: 262_144, policy: { filesystem: "best-effort", network: "best-effort", codeLoading: "best-effort" }, allowedEnvironmentKeys: ["PATH", "HOME", "USER", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND"] });
  const description: TargetDescription = { id: options.targetId, kind: "development-pc", available: true, capabilities: ["filesystem.read", "filesystem.write", "execution.run"], workspace: { id: options.workspaceId, path: options.workspaceRoot, repository: "git@github.com:eugen252009/Porta.git" }, platform: platform() };
  const boundary = new WorkspaceBoundary(options.workspaceRoot);
  const operations = new ToolProviderTargetTransport(description, { filesystem, execution }, async (path) => { const resolved = await boundary.resolveMutation(path); if (!resolved.exists) throw new Error("File does not exist."); await fs.unlink(resolved.path); return { deleted: path }; });
  const identity = new InstanceIdentityStore(options.identityDirectory);
  const server = createTargetTransportServer({ target: description, identity, operations, allowedIdentities: options.allowedClientIdentities });
  const address = await server.listen(options.host ?? "127.0.0.1", options.port ?? 0);
  return { ...server, address, target: description, identity: identity.public };
}
