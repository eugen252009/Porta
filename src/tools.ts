import { ToolContext, ToolDescriptor, ToolInvocation, ToolProvider, ToolResult, toolDescriptorSchema, toolInvocationSchema, toolResultSchema, failure, HarnessFailure, id } from "./contracts.js";

export interface CanonicalToolDescriptor extends ToolDescriptor { readonly providerId: string; readonly canonicalId: string }

export class ToolRouter {
  private readonly providers = new Map<string, ToolProvider>();
  private readonly tools = new Map<string, { provider: ToolProvider; descriptor: CanonicalToolDescriptor }>();
  async register(providerId: string, provider: ToolProvider, context: ToolContext): Promise<readonly CanonicalToolDescriptor[]> {
    if (!id.safeParse(providerId).success) throw failure("VALIDATION_FAILED", `Tool provider identity '${providerId}' is invalid.`);
    if (this.providers.has(providerId)) throw failure("CAPABILITY_CONFLICT", `Tool provider '${providerId}' is already registered.`);
    const descriptors = [...await provider.listTools(context)].sort((left, right) => left.id.localeCompare(right.id));
    const localIds = new Set<string>();
    for (const descriptor of descriptors) {
      const parsed = toolDescriptorSchema.safeParse(descriptor);
      if (!parsed.success) throw failure("VALIDATION_FAILED", `Tool provider '${providerId}' returned an invalid descriptor.`, false, { issues: parsed.error.issues });
      if (localIds.has(descriptor.id)) throw failure("CAPABILITY_CONFLICT", `Tool provider '${providerId}' returned duplicate tool '${descriptor.id}'.`);
      localIds.add(descriptor.id);
      const canonicalId = `${providerId}/${descriptor.id}`;
      if (this.tools.has(canonicalId)) throw failure("CAPABILITY_CONFLICT", `Canonical tool '${canonicalId}' is already registered.`);
      const canonical = deepFreeze({ ...descriptor, providerId, canonicalId });
      this.tools.set(canonicalId, { provider, descriptor: canonical });
    }
    this.providers.set(providerId, provider);
    return this.listTools();
  }
  listTools(): readonly CanonicalToolDescriptor[] { return [...this.tools.values()].map((entry) => entry.descriptor).sort((left, right) => left.canonicalId.localeCompare(right.canonicalId)); }
  descriptorFor(toolId: string): CanonicalToolDescriptor | undefined { return this.tools.get(toolId)?.descriptor; }
  async invoke(request: ToolInvocation, context: ToolContext): Promise<ToolResult> {
    const parsed = toolInvocationSchema.safeParse(request);
    if (!parsed.success) return { ok: false, error: failure("VALIDATION_FAILED", "Tool invocation is invalid.", false, { issues: parsed.error.issues }).error };
    const entry = this.tools.get(request.toolId);
    if (!entry) return { ok: false, error: failure("CAPABILITY_UNAVAILABLE", `Tool '${request.toolId}' is unavailable.`).error };
    try {
      const result = await entry.provider.invoke({ ...request, toolId: entry.descriptor.id }, context);
      const valid = toolResultSchema.safeParse(result);
      if (!valid.success) return { ok: false, error: failure("TOOL_FAILED", "Tool provider returned an invalid result.", false, { issues: valid.error.issues }).error };
      return result;
    } catch (error) {
      if (error instanceof HarnessFailure) return { ok: false, error: error.error };
      return { ok: false, error: { code: context.signal.aborted ? "CANCELLED" : context.deadline !== undefined && context.deadline <= Date.now() ? "TIMEOUT" : "TOOL_FAILED", message: error instanceof Error ? error.message : "Tool invocation failed.", retryable: false } };
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
