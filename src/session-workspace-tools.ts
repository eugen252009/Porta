import { ArtifactStore } from "./artifact.js";
import { ExecutionToolProvider, ExecutionProviderConfig } from "./execution.js";
import { FilesystemProviderConfig, FilesystemToolProvider, ModelContentReducer } from "./filesystem.js";
import { GitCredentialStore } from "./git-credentials.js";
import { CliGitBackend, GitToolProvider } from "./git.js";
import { ModelProvider, RuntimeHost, SandboxProvider, ToolAuthorizationDecision, ToolAuthorizationPolicy, ToolAuthorizationRequest, ToolContext, ToolDescriptor, ToolInvocation, ToolProvider, ToolResult, failure } from "./contracts.js";
import { WorkspaceFileAccess, WorkspaceToolAuthorizationPolicy } from "./workspace-permissions.js";
import { SessionWorkspaceManager } from "./session-workspaces.js";
import { HostProcessRuntime } from "./adapters/runtime-host-process.js";
import { HostProcessSandbox } from "./adapters/sandbox-host-process.js";
import { BubblewrapSandbox } from "./adapters/sandbox-bubblewrap.js";
import { selectSandbox } from "./sandbox-selection.js";
import { LinearTextSearchEngine } from "./search.js";
import type { PortaConfig } from "./porta-config.js";

export interface SessionWorkspaceToolFactoryOptions {
  readonly manager: SessionWorkspaceManager;
  readonly credentials: GitCredentialStore;
  readonly config: PortaConfig;
  readonly model: ModelProvider;
  readonly artifacts: ArtifactStore;
  readonly baseWorkspace: string;
  readonly runtime?: RuntimeHost;
  readonly sandboxes?: readonly SandboxProvider[];
  readonly sandbox?: SandboxProvider;
  readonly sandboxForWorkspace?: (workspaceRoot: string) => SandboxProvider;
}

export class SessionWorkspaceToolFactory {
  private readonly providers = new Map<string, Promise<Readonly<Record<string, ToolProvider | undefined>>>>();
  private readonly runtime: RuntimeHost;
  constructor(private readonly options: SessionWorkspaceToolFactoryOptions) { this.runtime = options.runtime ?? new HostProcessRuntime(); }
  async forSession(sessionId: string): Promise<Readonly<Record<string, ToolProvider | undefined>>> {
    const root = await this.options.manager.workspaceForSession(sessionId);
    let providers = this.providers.get(root);
    if (!providers) { providers = this.create(root); this.providers.set(root, providers); }
    return providers;
  }
  templates(): Readonly<Record<string, ToolProvider | undefined>> {
    const { config, model, artifacts, baseWorkspace } = this.options;
    const access = config.authorization.mode === "workspace" && config.filesystem ? new WorkspaceFileAccess(baseWorkspace, config.authorization.sensitivePaths) : undefined;
    const filesystem = config.filesystem ? new FilesystemToolProvider({ ...config.filesystem, root: baseWorkspace }, new ModelContentReducer(model), new LinearTextSearchEngine(), undefined, access) : undefined;
    const git = config.git?.enabled ? new GitToolProvider(new CliGitBackend({ root: baseWorkspace, executable: config.git.executable, maxStatusEntries: config.git.maxStatusEntries, maxDiffBytes: config.git.maxDiffBytes, maxShowBytes: config.git.maxShowBytes, maxLogEntries: config.git.maxLogEntries })) : undefined;
    const execution = config.execution?.enabled ? new ExecutionToolProvider(this.runtime, this.options.sandbox ?? new HostProcessSandbox(), executionConfig(config.execution, baseWorkspace, artifacts, config.persistence?.maxArtifactBytes)) : undefined;
    return { filesystem, git, execution };
  }
  authorizationPolicy(): ToolAuthorizationPolicy | undefined {
    const { config, manager } = this.options;
    if (config.authorization.mode !== "workspace" || !config.filesystem) return undefined;
    return new SessionWorkspaceAuthorizationPolicy(manager, config.authorization.sensitivePaths);
  }
  private async create(root: string): Promise<Readonly<Record<string, ToolProvider | undefined>>> {
    const { config, model, artifacts, credentials } = this.options;
    const access = config.authorization.mode === "workspace" && config.filesystem ? new WorkspaceFileAccess(root, config.authorization.sensitivePaths) : undefined;
    const filesystem = config.filesystem ? new FilesystemToolProvider({ ...config.filesystem, root }, new ModelContentReducer(model), new LinearTextSearchEngine(), undefined, access) : undefined;
    const gitConfig = config.git;
    const git = gitConfig?.enabled ? new GitToolProvider(new CliGitBackend({ root, executable: gitConfig.executable, maxStatusEntries: gitConfig.maxStatusEntries, maxDiffBytes: gitConfig.maxDiffBytes, maxShowBytes: gitConfig.maxShowBytes, maxLogEntries: gitConfig.maxLogEntries, credentialEnvironment: async (context, remote) => { if (!context.sessionId) throw failure("AUTHORIZATION_DENIED", "Git credentials require a session-bound operation."); return credentials.resolveForClone(context.sessionId, await this.options.manager.credentialIdsForSession(context.sessionId), remote); }, credentialStatus: async (context) => context.sessionId ? credentials.describeAssignments(context.sessionId, await this.options.manager.credentialIdsForSession(context.sessionId)) : { configured: false, credentials: [] } })) : undefined;
    let execution: ExecutionToolProvider | undefined;
    if (config.execution?.enabled) {
      const executionSettings = config.execution;
      const host = new HostProcessSandbox();
      const workspaceSandbox = this.options.sandboxForWorkspace?.(root) ?? (this.options.sandbox instanceof BubblewrapSandbox ? new BubblewrapSandbox({ workspaceRoot: root }) : undefined);
      const candidates = [new BubblewrapSandbox({ workspaceRoot: root }), ...(this.options.sandboxes ?? []).filter((provider) => provider.capabilities.filesystem === "best-effort"), host];
      const sandbox = workspaceSandbox ?? (this.options.sandbox?.capabilities.filesystem === "best-effort" ? this.options.sandbox : undefined) ?? (await selectSandbox({ filesystem: executionSettings.filesystem, network: executionSettings.network, codeLoading: executionSettings.codeLoading }, candidates.map((provider) => { const available = (provider as SandboxProvider & { available?: () => Promise<boolean> }).available; return available ? { provider, available: () => available.call(provider) } : { provider }; }), executionSettings.sandbox.preference)).provider;
      const confined = config.authorization.mode !== "workspace" || ["native", "external"].includes(sandbox.capabilities.filesystem);
      if (confined) execution = new ExecutionToolProvider(this.runtime, sandbox, executionConfig(executionSettings, root, artifacts, config.persistence?.maxArtifactBytes));
    }
    return { filesystem, git, execution };
  }
}

export class SessionScopedToolProvider implements ToolProvider {
  constructor(private readonly providerId: "filesystem" | "execution" | "git", private readonly factory: SessionWorkspaceToolFactory, private readonly templates: Readonly<Record<string, ToolProvider | undefined>>) {}
  async listTools(context: ToolContext): Promise<readonly ToolDescriptor[]> { return this.templates[this.providerId]?.listTools(context) ?? []; }
  async invoke(request: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    const provider = (await this.factory.forSession(context.sessionId))[this.providerId];
    return provider ? provider.invoke(request, context) : { ok: false, error: failure("CAPABILITY_UNAVAILABLE", `Session ${this.providerId} capability is unavailable.`).error };
  }
}

export class SessionWorkspaceAuthorizationPolicy implements ToolAuthorizationPolicy {
  constructor(private readonly manager: SessionWorkspaceManager, private readonly sensitivePaths: readonly string[] = []) {}
  async authorize(request: ToolAuthorizationRequest): Promise<ToolAuthorizationDecision> {
    const root = await this.manager.workspaceForSession(request.context.sessionId);
    return new WorkspaceToolAuthorizationPolicy(new WorkspaceFileAccess(root, this.sensitivePaths)).authorize(request);
  }
}
function executionConfig(config: NonNullable<PortaConfig["execution"]>, root: string, artifactStore: ArtifactStore, maxArtifactBytes?: number): ExecutionProviderConfig {
  return { workspaceRoot: root, allowedCommands: config.allowedCommands, defaultTimeoutMs: config.defaultTimeoutMs, maxStdoutBytes: config.maxStdoutBytes, maxStderrBytes: config.maxStderrBytes, ...(maxArtifactBytes === undefined ? {} : { maxArtifactBytes }), artifactStore, policy: { filesystem: config.filesystem, network: config.network, codeLoading: config.codeLoading }, environment: config.environment, allowedEnvironmentKeys: config.allowedEnvironmentKeys };
}
