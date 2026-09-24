import type { PortaConfig } from "./porta-config.js";
import type { ModelCapabilities, ToolAuthorizationPolicy, ToolDescriptor } from "./contracts.js";
import type { ToolRouter } from "./tools.js";
import type { DelegatedTask } from "./delegation.js";

export interface SessionCapabilityInspection {
  sessionId: string;
  model: { supportsTools?: boolean; effectiveToolCount: number };
  workspace: { root?: string; filesystem: "allow" | "approval" | "deny" | "unavailable" };
  execution: { enabled: boolean; filesystem: string; network: string; codeLoading: string };
  scratchpad: { local: { read: "allow"; write: "allow" }; inherited: readonly string[] };
  delegation: { allowed: boolean; effectiveCapabilities: readonly string[]; restrictions: readonly string[] };
  tools: readonly { id: string; capabilities: readonly string[]; visibility: "available" | "approval-required" | "unavailable" }[];
}

export async function inspectSessionCapabilities(sessionId: string, config: PortaConfig, router: ToolRouter, _policy: ToolAuthorizationPolicy, delegated?: DelegatedTask, model?: ModelCapabilities): Promise<SessionCapabilityInspection> {
  const authorization = config.authorization.mode;
  const filesystem = config.filesystem ? (authorization === "allow-all" ? "allow" : authorization === "workspace" ? "allow" : "approval") : "unavailable";
  const descriptors = model?.tools === false ? [] : router.listTools();
  const tools = descriptors.map((descriptor) => {
    const capabilities = descriptor.capabilities ?? [];
    const local = capabilities.some((capability) => capability.startsWith("scratchpad.") || capability.startsWith("task.") || capability.startsWith("artifact."));
    const filesystemTool = capabilities.some((capability) => capability.startsWith("filesystem."));
    const executionTool = capabilities.some((capability) => capability === "process.execute");
    return { id: (descriptor as ToolDescriptor & { canonicalId?: string }).canonicalId ?? descriptor.name, capabilities, visibility: local || (filesystemTool && filesystem !== "unavailable") ? "available" as const : executionTool ? "approval-required" as const : authorization === "allow-all" ? "available" as const : "approval-required" as const };
  });
  return {
    sessionId,
    model: { ...(model?.tools === undefined ? {} : { supportsTools: model.tools }), effectiveToolCount: tools.length },
    workspace: { ...(config.filesystem?.root ? { root: config.filesystem.root } : {}), filesystem: filesystem as SessionCapabilityInspection["workspace"]["filesystem"] },
    execution: { enabled: Boolean(config.execution?.enabled), filesystem: config.execution?.filesystem ?? "unavailable", network: config.execution?.network ?? "unavailable", codeLoading: config.execution?.codeLoading ?? "unavailable" },
    scratchpad: { local: { read: "allow", write: "allow" }, inherited: delegated?.scratchpadNamespace ? [delegated.scratchpadNamespace] : [] },
    delegation: { allowed: Boolean(config.delegation?.enabled), effectiveCapabilities: delegated?.effectivePermissions ?? [], restrictions: delegated?.restrictions ?? [] },
    tools,
  };
}
