import { MCPToolProvider } from "./adapters/tool-mcp.js";
import { OllamaModelProvider } from "./adapters/model-ollama.js";
import { InteractiveApprovalGateway } from "./application-gateway.js";
import { AllowAllToolAuthorizationPolicy, StaticToolAuthorizationPolicy } from "./authorization-mocks.js";
import { PortaConfig } from "./porta-config.js";
import { ConversationStore } from "./contracts.js";
import { MemoryConversationStore } from "./conversation.js";
import { HarnessFailure, ModelProvider, ToolContext } from "./contracts.js";
import { planPlugins } from "./plugin-preflight.js";
import { PendingApprovalProvider } from "./approval-pending.js";
import { ToolRouter } from "./tools.js";

export interface PortaApplication {
  readonly gateway: InteractiveApprovalGateway;
  readonly pendingApprovals: PendingApprovalProvider;
  readonly toolRouter: ToolRouter;
  readonly conversations: ConversationStore;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface PortaFactories { model?: (config: PortaConfig["model"]) => ModelProvider; mcp?: (config: import("./adapters/tool-mcp.js").McpStdioConfig) => MCPToolProvider; conversations?: ConversationStore }

export async function createPortaApplication(config: PortaConfig, factories: PortaFactories = {}): Promise<PortaApplication> {
  const model = factories.model?.(config.model) ?? new OllamaModelProvider(config.model);
  const providers = config.tools.map((tool) => factories.mcp?.({ providerId: tool.id, ...tool.transport }) ?? new MCPToolProvider({ providerId: tool.id, ...tool.transport }));
  const modelManifest = { schemaVersion: 1 as const, id: "model.ollama", version: "1", provides: [{ id: "model.text", version: "1" }, { id: "model.streaming", version: "1" }], requires: [] };
  const manifests = [modelManifest, ...providers.map((provider) => ({ schemaVersion: 1 as const, id: `tools.mcp.${provider.providerId}`, version: "1", provides: [{ id: "tools.discovery", version: "1" }, { id: "tools.invoke", version: "1" }], requires: [] }))];
  const plan = planPlugins(manifests);
  if (plan.status !== "ready") throw new HarnessFailure({ code: "PLUGIN_INVALID", message: "Porta plugin preflight failed.", retryable: false, details: plan.diagnostics });
  const healthy: { close?: () => Promise<void> }[] = [];
  try {
    if ("health" in model && typeof model.health === "function") { const status = await model.health(); if (status.status !== "healthy") throw new HarnessFailure({ code: "CAPABILITY_UNAVAILABLE", message: status.message ?? "Model provider is unhealthy.", retryable: false, details: status }); }
    for (const provider of providers) { const status = await provider.health(); if (status.status !== "healthy") throw new HarnessFailure({ code: "CAPABILITY_UNAVAILABLE", message: status.message ?? `Tool provider '${provider.providerId}' is unhealthy.`, retryable: false, details: status }); healthy.push(provider); }
    const router = new ToolRouter();
    const context: ToolContext = { traceId: "startup", sessionId: "startup", executionId: "startup", signal: new AbortController().signal };
    for (const provider of providers) await router.register(provider.providerId, provider, context);
    const pending = new PendingApprovalProvider();
    const conversations = factories.conversations ?? new MemoryConversationStore(config.conversation);
    const policy = config.authorization.mode === "allow-all" ? new AllowAllToolAuthorizationPolicy() : new StaticToolAuthorizationPolicy("require-approval");
    const gateway = new InteractiveApprovalGateway(model, router, pending, policy, { maxSteps: config.agent.maxSteps ?? 8, maxToolCalls: config.agent.maxToolCalls ?? 16 }, conversations);
    let stopped = false;
    return { gateway, pendingApprovals: pending, toolRouter: router, conversations, async start() { if (stopped) throw new Error("Porta application is shut down."); }, async shutdown() { if (stopped) return; stopped = true; await gateway.shutdown(); for (const provider of [...providers].reverse()) await provider.close(); } };
  } catch (error) { for (const provider of [...healthy].reverse()) await provider.close?.(); throw error; }
}

/** @deprecated Use PortaApplication. */
export type HarnessApplication = PortaApplication;
/** @deprecated Use PortaFactories. */
export type HarnessFactories = PortaFactories;
/** @deprecated Use createPortaApplication. */
export const createHarnessApplication = createPortaApplication;
