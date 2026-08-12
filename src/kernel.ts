import { randomUUID } from "node:crypto";
import { CapabilityDescriptor, CapabilityRequirement, CapabilityResolver, ComponentContext, failure, HarnessError, HarnessFailure, HarnessPlugin, KernelCommand, KernelEvent, ModelProvider, Storage, Session, ApplicationGateway, CommandContext } from "./contracts.js";

export class CapabilityRegistry implements CapabilityResolver {
  private readonly entries = new Map<string, CapabilityDescriptor>();
  register(descriptor: CapabilityDescriptor): void {
    const current = this.entries.get(descriptor.id);
    if (current && current.version !== descriptor.version) throw failure("CAPABILITY_CONFLICT", `Capability '${descriptor.id}' has conflicting versions.`);
    this.entries.set(descriptor.id, descriptor);
  }
  resolve(requirement: CapabilityRequirement): CapabilityDescriptor | undefined {
    const found = this.entries.get(requirement.capability);
    if (!found) {
      if (requirement.optional) return undefined;
      throw failure("CAPABILITY_UNAVAILABLE", `Required capability '${requirement.capability}' is unavailable.`);
    }
    if (requirement.version && found.version !== requirement.version) throw failure("CAPABILITY_UNAVAILABLE", `Capability '${requirement.capability}' does not satisfy version '${requirement.version}'.`);
    return found;
  }
  resolveAll(requirements: readonly CapabilityRequirement[]): readonly CapabilityDescriptor[] { return requirements.flatMap((requirement) => { const resolved = this.resolve(requirement); return resolved ? [resolved] : []; }); }
}

export class PluginManager {
  private readonly components: unknown[] = [];
  constructor(readonly registry = new CapabilityRegistry()) {}
  async register(plugins: readonly HarnessPlugin[]): Promise<void> {
    const manifests = new Set<string>();
    for (const plugin of plugins) {
      if (manifests.has(plugin.manifest.id)) throw failure("PLUGIN_INVALID", `Duplicate plugin '${plugin.manifest.id}'.`);
      manifests.add(plugin.manifest.id);
      for (const requirement of plugin.manifest.requires) this.registry.resolve(requirement);
      for (const capability of plugin.manifest.provides) this.registry.register(capability);
    }
    const registrar = { provide: (capability: CapabilityDescriptor, component: unknown) => { this.registry.register(capability); this.components.push(component); } };
    for (const plugin of plugins) await plugin.register(registrar);
    const context: ComponentContext = { capabilities: this.registry };
    const initialized: HarnessPlugin[] = [];
    const started: HarnessPlugin[] = [];
    try {
      for (const plugin of plugins) { if (plugin.initialize) await plugin.initialize(context); initialized.push(plugin); }
      for (const plugin of plugins) { if (plugin.start) await plugin.start(); started.push(plugin); }
    } catch (error) {
      for (const plugin of [...started, ...initialized.filter((plugin) => !started.includes(plugin))].reverse()) if (plugin.stop) await plugin.stop();
      throw error;
    }
  }
  async stop(plugins: readonly HarnessPlugin[]): Promise<void> { for (const plugin of [...plugins].reverse()) if (plugin.stop) await plugin.stop(); }
}

export class HarnessKernel implements ApplicationGateway {
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly storage: Storage, private readonly model: ModelProvider) {}
  async *execute(command: KernelCommand, context: CommandContext = {}): AsyncIterable<KernelEvent> {
    try {
      if (command.type === "CreateSession") {
        const session: Session = { schemaVersion: 1, id: randomUUID(), state: "open", createdAt: new Date().toISOString() };
        await this.storage.createSession(session); yield { type: "SessionCreated", sessionId: session.id }; return;
      }
      const session = await this.storage.getSession(command.sessionId);
      if (!session || session.state !== "open") throw failure("STORAGE_FAILED", `Session '${command.sessionId}' is unavailable.`);
      if (command.type === "CloseSession") { await this.storage.closeSession(command.sessionId); yield { type: "SessionClosed", sessionId: command.sessionId }; return; }
      if (command.type === "CancelExecution") { this.active.get(command.sessionId)?.abort(); return; }
      const controller = new AbortController(); this.active.set(command.sessionId, controller);
      if (context.signal?.aborted) controller.abort();
      else if (context.signal) context.signal.addEventListener("abort", () => controller.abort(), { once: true });
      const deadline = context.deadline ?? undefined;
      const executionId = randomUUID();
      yield { type: "ExecutionStarted", executionId }; yield { type: "OutputStarted" };
      try {
        for await (const event of this.model.generate({ schemaVersion: 1, requestId: randomUUID(), input: command.input }, { traceId: context.traceId ?? randomUUID(), sessionId: command.sessionId, executionId, signal: controller.signal, deadline })) {
          if (controller.signal.aborted) { yield { type: "ExecutionCancelled" }; return; }
          yield event.type === "delta" ? { type: "OutputDelta", text: event.text } : { type: "OutputCompleted" };
        }
        if (controller.signal.aborted) yield { type: "ExecutionCancelled" }; else yield { type: "ExecutionCompleted" };
      } catch (error) { if (controller.signal.aborted) yield { type: "ExecutionCancelled" }; else yield { type: "Error", error: normalizeError(error, "MODEL_FAILED") }; }
      finally { this.active.delete(command.sessionId); }
    } catch (error) { yield { type: "Error", error: normalizeError(error) }; }
  }
}
function normalizeError(error: unknown, fallback: HarnessError["code"] = "INTERNAL_ERROR"): HarnessError { if (error instanceof HarnessFailure) return error.error; return { code: fallback, message: error instanceof Error ? error.message : "Unexpected failure.", retryable: false }; }
