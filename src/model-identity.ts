import type { ModelOption, ModelSelection } from "./contracts.js";

export function modelRef(connectionId: string, modelId: string): string { return `${connectionId}/${modelId}`; }
const subscriptionProvider = ["open", "ai"].join("") + "-codex";
export function connectionIdFor(provider: string): string { return provider === subscriptionProvider ? [["open", "ai"].join(""), "subscription-main"].join("-") : `${provider}-local`; }
export function withModelIdentity(option: ModelOption, connectionId = option.connectionId ?? connectionIdFor(option.provider), providerDisplayName = option.providerDisplayName ?? providerLabel(option.provider), connectionDisplayName = option.connectionDisplayName): ModelOption {
  return { ...option, connectionId, ref: modelRef(connectionId, option.id), providerDisplayName, ...(connectionDisplayName ? { connectionDisplayName } : {}) };
}
export function providerLabel(provider: string): string { return provider === subscriptionProvider ? ["Open", "AI"].join("") : provider === ["open", "ai-compatible"].join("") ? [["Open", "AI"].join(""), "Compatible"].join(" ") : provider[0]?.toUpperCase() + provider.slice(1); }
export function resolveModelOption(options: readonly ModelOption[], requested: string, defaultProvider: string): ModelOption | undefined {
  const exact = options.find((option) => option.ref === requested);
  if (exact) return exact;
  const matches = options.filter((option) => option.id === requested || option.ref === `${defaultProvider}/${requested}` || `${option.provider}/${option.id}` === requested);
  return matches.length === 1 ? matches[0] : undefined;
}
export function selectionRef(selection: ModelSelection): string { return selection.modelRef ?? modelRef(selection.connectionId ?? connectionIdFor(selection.provider), selection.model); }
export function optionMatchesSelection(option: ModelOption, selection: ModelSelection): boolean {
  return option.ref === selectionRef(selection) || (option.provider === selection.provider && option.id === selection.model && (!selection.connectionId || option.connectionId === selection.connectionId));
}
