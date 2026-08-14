import { MCPToolProvider } from "./adapters/tool-mcp.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { OllamaModelProvider } from "./adapters/model-ollama.js";
import { ConversationContextOptions, InteractiveApprovalGateway } from "./application-gateway.js";
import { ConversationCompactor, ModelConversationCompactor } from "./compaction.js";
import { AllowAllToolAuthorizationPolicy, StaticToolAuthorizationPolicy } from "./authorization-mocks.js";
import { PortaConfig } from "./porta-config.js";
import { ConversationStore, ModelProvider, ToolContext, ToolProvider } from "./contracts.js";
import { MemoryConversationStore } from "./conversation.js";
import { ContentReducer as ReducerContract } from "./content-reducer.js";
import { FilesystemSearchSource, FilesystemToolProvider, ModelContentReducer } from "./filesystem.js";
import { CCCSearchEngine, GrepSearchEngine, LinearTextSearchEngine, RipgrepSearchEngine, SearchEngine, selectSearchEngine } from "./search.js";
import { MemoryScratchpadStore, ScratchpadSearchSource, ScratchpadStore, ScratchpadToolProvider } from "./scratchpad.js";
import { HarnessFailure } from "./contracts.js";
import { planPlugins } from "./plugin-preflight.js";
import { PendingApprovalProvider } from "./approval-pending.js";
import { ToolRouter } from "./tools.js";

export interface PortaApplication {
  readonly gateway: InteractiveApprovalGateway;
  readonly pendingApprovals: PendingApprovalProvider;
  readonly toolRouter: ToolRouter;
  readonly conversations: ConversationStore;
  readonly scratchpad: ScratchpadStore;
  readonly searchEngines: { filesystem?: string; scratchpad: string };
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface PortaFactories { model?: (config: PortaConfig["model"]) => ModelProvider; mcp?: (config: import("./adapters/tool-mcp.js").McpStdioConfig) => MCPToolProvider; conversations?: ConversationStore; scratchpad?: ScratchpadStore; contentReducer?: ReducerContract; compactor?: ConversationCompactor }

export async function createPortaApplication(config: PortaConfig, factories: PortaFactories = {}): Promise<PortaApplication> {
  const model = factories.model?.(config.model) ?? new OllamaModelProvider(config.model);
  const mcpProviders = config.tools.map((tool) => factories.mcp?.({ providerId: tool.id, ...tool.transport }) ?? new MCPToolProvider({ providerId: tool.id, ...tool.transport }));
  const scratchpad = factories.scratchpad ?? new MemoryScratchpadStore();
  const searchCandidates: readonly SearchEngine[] = [new CCCSearchEngine(), new RipgrepSearchEngine(), new GrepSearchEngine(), new LinearTextSearchEngine()];
  const scratchpadEngine = selectSearchEngine(new ScratchpadSearchSource(scratchpad), searchCandidates) ?? new LinearTextSearchEngine();
  const filesystemRoot = config.filesystem ? realpathSync(resolve(config.filesystem.root)) : undefined;
  const filesystemEngine = filesystemRoot ? selectSearchEngine(new FilesystemSearchSource(filesystemRoot, config.filesystem?.maxReadBytes ?? 8 * 1024 * 1024), searchCandidates) ?? new LinearTextSearchEngine() : undefined;
  const filesystem = config.filesystem ? new FilesystemToolProvider(config.filesystem, factories.contentReducer ?? new ModelContentReducer(model), filesystemEngine) : undefined;
  const registrations: readonly { id: string; provider: ToolProvider }[] = [...mcpProviders.map((provider) => ({ id: provider.providerId, provider })), ...(filesystem ? [{ id: "filesystem", provider: filesystem as ToolProvider }] : []), { id: "scratchpad", provider: new ScratchpadToolProvider(scratchpad, scratchpadEngine) }];
  const modelManifest = { schemaVersion: 1 as const, id: "model.ollama", version: "1", provides: [{ id: "model.text", version: "1" }, { id: "model.streaming", version: "1" }], requires: [] };
  const manifests = [modelManifest, ...registrations.map((registration) => ({ schemaVersion: 1 as const, id: `tools.${registration.id}`, version: "1", provides: [{ id: "tools.discovery", version: "1" }, { id: "tools.invoke", version: "1" }], requires: [] }))];
  const plan = planPlugins(manifests);
  if (plan.status !== "ready") throw new HarnessFailure({ code: "PLUGIN_INVALID", message: "Porta plugin preflight failed.", retryable: false, details: plan.diagnostics });
  const healthy: { close?: () => Promise<void> }[] = [];
  try {
    if ("health" in model && typeof model.health === "function") { const status = await model.health(); if (status.status !== "healthy") throw new HarnessFailure({ code: "CAPABILITY_UNAVAILABLE", message: status.message ?? "Model provider is unhealthy.", retryable: false, details: status }); }
    for (const provider of mcpProviders) { const status = await provider.health(); if (status.status !== "healthy") throw new HarnessFailure({ code: "CAPABILITY_UNAVAILABLE", message: status.message ?? `Tool provider '${provider.providerId}' is unhealthy.`, retryable: false, details: status }); healthy.push(provider); }
    const router = new ToolRouter();
    const context: ToolContext = { traceId: "startup", sessionId: "startup", executionId: "startup", signal: new AbortController().signal };
    for (const registration of registrations) await router.register(registration.id, registration.provider, context);
    const pending = new PendingApprovalProvider();
    const conversations = factories.conversations ?? new MemoryConversationStore(config.conversation);
    const policy = config.authorization.mode === "allow-all" ? new AllowAllToolAuthorizationPolicy() : new StaticToolAuthorizationPolicy("require-approval");
    const compaction = config.conversation.compaction;
    const contextOptions: ConversationContextOptions = compaction ? { enabled: compaction.enabled, threshold: config.conversation.maxTurns, keepRecentTurns: compaction.keepRecentTurns, maxManifestEntries: compaction.maxManifestEntries, compactor: factories.compactor ?? new ModelConversationCompactor(model), scratchpad } : {};
    const gateway = new InteractiveApprovalGateway(model, router, pending, policy, { maxSteps: config.agent.maxSteps ?? 8, maxToolCalls: config.agent.maxToolCalls ?? 16 }, conversations, contextOptions);
    let stopped = false;
    return { gateway, pendingApprovals: pending, toolRouter: router, conversations, scratchpad, searchEngines: { ...(filesystemEngine ? { filesystem: filesystemEngine.name } : {}), scratchpad: scratchpadEngine.name }, async start() { if (stopped) throw new Error("Porta application is shut down."); }, async shutdown() { if (stopped) return; stopped = true; await gateway.shutdown(); for (const provider of [...mcpProviders].reverse()) await provider.close(); } };
  } catch (error) { for (const provider of [...healthy].reverse()) await provider.close?.(); throw error; }
}

/** @deprecated Use PortaApplication. */
export type HarnessApplication = PortaApplication;
/** @deprecated Use PortaFactories. */
export type HarnessFactories = PortaFactories;
/** @deprecated Use createPortaApplication. */
export const createHarnessApplication = createPortaApplication;
