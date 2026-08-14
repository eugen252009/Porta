import { EnforcementLevel, ExecutionPolicy, SandboxProvider, failure } from "./contracts.js";
import { evaluateExecutionPolicy } from "./runtime.js";

export interface SandboxSelectionCandidate { readonly provider: SandboxProvider; readonly available?: () => Promise<boolean> }
export interface SandboxSelection { readonly provider: SandboxProvider; readonly candidates: readonly string[] }

export async function selectSandbox(policy: ExecutionPolicy, candidates: readonly SandboxSelectionCandidate[], preference: readonly string[] = []): Promise<SandboxSelection> {
  const available: SandboxProvider[] = [];
  for (const candidate of candidates) { if (candidate.available && !(await candidate.available())) continue; available.push(candidate.provider); }
  const compatible = available.filter((provider) => evaluateExecutionPolicy(policy, provider.capabilities).allowed);
  if (!compatible.length) throw failure("POLICY_VIOLATION", "No available sandbox can enforce the requested execution policy.", false, { policy, available: available.map((provider) => ({ provider: provider.descriptor.id, capabilities: provider.capabilities })) });
  const preferenceRank = (provider: SandboxProvider) => { const index = preference.indexOf(provider.descriptor.id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  compatible.sort((left, right) => preferenceRank(left) - preferenceRank(right) || strength(right, policy) - strength(left, policy) || left.descriptor.id.localeCompare(right.descriptor.id));
  return { provider: compatible[0]!, candidates: available.map((provider) => provider.descriptor.id) };
}
function strength(provider: SandboxProvider, policy: ExecutionPolicy): number { return (["filesystem", "network", "codeLoading"] as const).reduce((score, dimension) => score + level(provider.capabilities[dimension]) * (policy[dimension] === "deny" ? 4 : policy[dimension] === "best-effort" ? 1 : 0), 0); }
function level(value: EnforcementLevel): number { return value === "native" ? 3 : value === "external" ? 2 : value === "best-effort" ? 1 : 0; }
