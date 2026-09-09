import { ModelOption } from "./contracts.js";
import { PortaConfig, savePortaConfig } from "./porta-config.js";
export type ProviderType = string;
export type ProviderProbe = (type: string, endpoint: string) => Promise<readonly ModelOption[]>;
async function defaultProbe(type: string, endpoint: string): Promise<readonly ModelOption[]> { const module = await import("./model-picker.js"); return module.fetchAvailableModelOptions(type as never, endpoint); }
export interface ProviderConfig { id: string; type: ProviderType; name: string; endpoint: string; model?: string }
export interface ProviderDescriptor extends ProviderConfig { status: "available" | "unavailable"; modelCount: number; credentialConfigured: boolean }
export class ProviderRegistry {
  private providers: ProviderConfig[];
  constructor(private readonly config: PortaConfig, private readonly configPath?: string, private readonly probe: ProviderProbe = defaultProbe) { this.providers = [...(config.providers ?? [])]; }
  list(): readonly ProviderConfig[] { return this.providers.map((provider) => ({ ...provider })); }
  byType(type: ProviderType): ProviderConfig | undefined { const provider = this.providers.find((entry) => entry.type === type); return provider ? { ...provider } : undefined; }
  get(id: string): ProviderConfig | undefined { const provider = this.providers.find((entry) => entry.id === id); return provider ? { ...provider } : undefined; }
  async models(): Promise<readonly ModelOption[]> { const result: ModelOption[] = []; for (const provider of this.providers) for (const model of await this.probe(provider.type, provider.endpoint)) result.push(model); return result; }
  async describe(): Promise<readonly ProviderDescriptor[]> { return Promise.all(this.providers.map(async (provider) => { const models = await this.probe(provider.type, provider.endpoint); return { ...provider, status: models.length ? "available" as const : "unavailable" as const, modelCount: models.length, credentialConfigured: false }; })); }
  async test(provider: ProviderConfig): Promise<{ models: readonly string[] }> { const models = await this.probe(provider.type, provider.endpoint); if (!models.length) throw new Error(`Unable to reach ${provider.type} at the configured endpoint.`); return { models: models.map((model) => model.id) }; }
  async create(provider: ProviderConfig): Promise<void> { if (this.providers.some((entry) => entry.id === provider.id)) throw new Error("A provider with this ID already exists."); await this.test(provider); this.providers.push({ ...provider }); await this.persist(); }
  async update(id: string, patch: Partial<Omit<ProviderConfig, "id" | "type">>): Promise<void> { const index = this.providers.findIndex((entry) => entry.id === id); if (index < 0) throw new Error("Provider was not found."); const next = { ...this.providers[index]!, ...patch }; await this.test(next); this.providers[index] = next; await this.persist(); }
  async delete(id: string): Promise<void> { const next = this.providers.filter((entry) => entry.id !== id); if (next.length === this.providers.length) throw new Error("Provider was not found."); this.providers = next; await this.persist(); }
  private async persist(): Promise<void> { await savePortaConfig({ ...this.config, providers: this.providers as PortaConfig["providers"] }, this.configPath); }
}
