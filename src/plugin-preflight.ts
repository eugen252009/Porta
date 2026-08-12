import { capabilityDescriptorSchema, capabilityRequirementSchema, pluginManifestSchema, CapabilityDescriptor, CapabilityRequirement, HarnessPlugin, PluginManifest } from "./contracts.js";

export type PluginDiagnosticCode = "PLUGIN_MANIFEST_INVALID" | "PLUGIN_ID_INVALID" | "PLUGIN_VERSION_INVALID" | "PLUGIN_SCHEMA_VERSION_UNSUPPORTED" | "PLUGIN_CAPABILITY_INVALID" | "PLUGIN_CAPABILITY_DUPLICATE" | "PLUGIN_REQUIREMENT_INVALID" | "PLUGIN_REQUIREMENT_DUPLICATE" | "PLUGIN_REQUIRED_CAPABILITY_MISSING" | "PLUGIN_OPTIONAL_CAPABILITY_MISSING" | "PLUGIN_CAPABILITY_CONFLICT" | "PLUGIN_DEPENDENCY_CYCLE" | "PLUGIN_DEPENDENCY_AMBIGUOUS" | "PLUGIN_NOT_LOADABLE";
export interface PluginDiagnostic { code: PluginDiagnosticCode; severity: "error" | "warning"; message: string; pluginId?: string; capability?: string; path?: string; details?: unknown }
export interface PluginValidationResult { valid: boolean; errors: readonly PluginDiagnostic[]; warnings: readonly PluginDiagnostic[] }
export interface PluginEnvironmentSnapshot { readonly availableCapabilities: readonly CapabilityDescriptor[]; readonly plugins: readonly PluginManifest[] }
export interface ResolvedRequirement { requirement: CapabilityRequirement; status: "resolved" | "missing" | "optional-missing" | "conflict"; providerPluginId?: string; resolvedCapability?: CapabilityDescriptor }
export interface PluginQualification { status: "loadable" | "loadable-with-warnings" | "not-loadable"; errors: readonly PluginDiagnostic[]; warnings: readonly PluginDiagnostic[]; resolvedRequirements: readonly ResolvedRequirement[] }
export interface PluginLoadPlan { status: "ready" | "not-ready"; activationOrder: readonly string[]; shutdownOrder: readonly string[]; qualifications: readonly PluginQualification[]; diagnostics: readonly PluginDiagnostic[] }

const diagnostic = (code: PluginDiagnosticCode, message: string, pluginId?: string, capability?: string, path?: string, details?: unknown): PluginDiagnostic => ({ code, severity: code === "PLUGIN_OPTIONAL_CAPABILITY_MISSING" ? "warning" : "error", message, ...(pluginId ? { pluginId } : {}), ...(capability ? { capability } : {}), ...(path ? { path } : {}), ...(details ? { details } : {}) });

export function validatePluginManifest(value: unknown): PluginValidationResult {
  const errors: PluginDiagnostic[] = []; const warnings: PluginDiagnostic[] = [];
  const parsed = pluginManifestSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join("."); const code = path === "schemaVersion" ? "PLUGIN_SCHEMA_VERSION_UNSUPPORTED" : path === "id" ? "PLUGIN_ID_INVALID" : path === "version" ? "PLUGIN_VERSION_INVALID" : path.startsWith("provides") ? "PLUGIN_CAPABILITY_INVALID" : "PLUGIN_REQUIREMENT_INVALID";
      errors.push(diagnostic(code, issue.message, undefined, undefined, path));
    }
    return { valid: false, errors, warnings };
  }
  const manifest = parsed.data;
  const provides = new Set<string>();
  manifest.provides.forEach((capability, index) => { if (provides.has(capability.id)) errors.push(diagnostic("PLUGIN_CAPABILITY_DUPLICATE", `Capability '${capability.id}' is provided more than once.`, manifest.id, capability.id, `provides.${index}`)); provides.add(capability.id); });
  const requirements = new Map<string, { optional: boolean; version?: string }>();
  manifest.requires.forEach((requirement, index) => {
    const prior = requirements.get(requirement.capability); const current = { optional: requirement.optional === true, ...(requirement.version ? { version: requirement.version } : {}) };
    if (prior && prior.optional === current.optional && prior.version === current.version) errors.push(diagnostic("PLUGIN_REQUIREMENT_DUPLICATE", `Requirement '${requirement.capability}' is duplicated.`, manifest.id, requirement.capability, `requires.${index}`));
    else if (prior && prior.optional !== current.optional) errors.push(diagnostic("PLUGIN_REQUIREMENT_INVALID", `Requirement '${requirement.capability}' mixes required and optional semantics.`, manifest.id, requirement.capability, `requires.${index}`));
    else if (prior && prior.version !== current.version) errors.push(diagnostic("PLUGIN_REQUIREMENT_INVALID", `Requirement '${requirement.capability}' declares contradictory versions.`, manifest.id, requirement.capability, `requires.${index}`));
    requirements.set(requirement.capability, current);
  });
  return { valid: errors.length === 0, errors, warnings };
}

export function snapshotEnvironment(environment: PluginEnvironmentSnapshot): PluginEnvironmentSnapshot {
  return Object.freeze({
    availableCapabilities: Object.freeze(environment.availableCapabilities.map((capability) => ({ ...capability, ...(capability.attributes ? { attributes: { ...capability.attributes } } : {}) }))),
    plugins: Object.freeze(environment.plugins.map((plugin) => ({ ...plugin, provides: plugin.provides.map((capability) => ({ ...capability })), requires: plugin.requires.map((requirement) => ({ ...requirement })) })))
  });
}

export function qualifyPlugin(manifest: PluginManifest, environment: PluginEnvironmentSnapshot): PluginQualification {
  const validation = validatePluginManifest(manifest); if (!validation.valid) return { status: "not-loadable", errors: validation.errors, warnings: validation.warnings, resolvedRequirements: [] };
  const errors = [...validation.errors]; const warnings = [...validation.warnings]; const resolvedRequirements: ResolvedRequirement[] = [];
  for (const requirement of manifest.requires) {
    const environmentMatches = environment.availableCapabilities.filter((capability) => capability.id === requirement.capability && (!requirement.version || capability.version === requirement.version));
    const providers = environment.plugins.filter((plugin) => plugin.provides.some((capability) => capability.id === requirement.capability && (!requirement.version || capability.version === requirement.version)));
    if (environmentMatches.length > 1 || providers.length > 1) { errors.push(diagnostic("PLUGIN_CAPABILITY_CONFLICT", `Capability '${requirement.capability}' has multiple matching providers.`, manifest.id, requirement.capability)); resolvedRequirements.push({ requirement, status: "conflict" }); }
    else if (environmentMatches[0]) resolvedRequirements.push({ requirement, status: "resolved", resolvedCapability: environmentMatches[0] });
    else if (providers[0]) { const capability = providers[0].provides.find((candidate) => candidate.id === requirement.capability && (!requirement.version || candidate.version === requirement.version)); resolvedRequirements.push({ requirement, status: "resolved", providerPluginId: providers[0].id, resolvedCapability: capability }); }
    else if (requirement.optional) { warnings.push(diagnostic("PLUGIN_OPTIONAL_CAPABILITY_MISSING", `Optional capability '${requirement.capability}' is unavailable.`, manifest.id, requirement.capability)); resolvedRequirements.push({ requirement, status: "optional-missing" }); }
    else { errors.push(diagnostic("PLUGIN_REQUIRED_CAPABILITY_MISSING", `Required capability '${requirement.capability}' is unavailable.`, manifest.id, requirement.capability)); resolvedRequirements.push({ requirement, status: "missing" }); }
  }
  return { status: errors.length ? "not-loadable" : warnings.length ? "loadable-with-warnings" : "loadable", errors, warnings, resolvedRequirements };
}

export function planPlugins(manifests: readonly PluginManifest[], environment: PluginEnvironmentSnapshot = { availableCapabilities: [], plugins: [] }): PluginLoadPlan {
  const all = [...environment.plugins, ...manifests]; const diagnostics: PluginDiagnostic[] = []; const qualifications: PluginQualification[] = []; const ids = new Set<string>();
  for (const manifest of manifests) { const validation = validatePluginManifest(manifest); if (ids.has(manifest.id)) diagnostics.push(diagnostic("PLUGIN_MANIFEST_INVALID", `Plugin '${manifest.id}' is duplicated.`, manifest.id)); ids.add(manifest.id); if (!validation.valid) diagnostics.push(...validation.errors); }
  const provided = new Map<string, { pluginId: string; capability: CapabilityDescriptor }[]>();
  for (const plugin of all) for (const capability of plugin.provides) { const entries = provided.get(capability.id) ?? []; entries.push({ pluginId: plugin.id, capability }); provided.set(capability.id, entries); }
  for (const [capability, entries] of provided) if (entries.length > 1 && new Set(entries.map((entry) => entry.capability.version)).size > 1) diagnostics.push(diagnostic("PLUGIN_CAPABILITY_CONFLICT", `Capability '${capability}' has incompatible providers.`, undefined, capability));
  const environmentForQualification = snapshotEnvironment({ availableCapabilities: environment.availableCapabilities, plugins: all });
  for (const manifest of manifests) { const qualification = qualifyPlugin(manifest, environmentForQualification); qualifications.push(qualification); diagnostics.push(...qualification.errors, ...qualification.warnings); }
  const graph = new Map<string, Set<string>>(); manifests.forEach((manifest) => graph.set(manifest.id, new Set()));
  for (const manifest of manifests) for (const resolution of qualifications[manifests.indexOf(manifest)]?.resolvedRequirements ?? []) if (resolution.providerPluginId && graph.has(resolution.providerPluginId)) graph.get(manifest.id)!.add(resolution.providerPluginId);
  const activation: string[] = []; const pending = new Set(manifests.map((manifest) => manifest.id));
  while (pending.size) { const ready = [...pending].filter((id) => [...graph.get(id)!].every((dependency) => activation.includes(dependency))).sort(); if (!ready.length) { diagnostics.push(diagnostic("PLUGIN_DEPENDENCY_CYCLE", "Plugin dependency graph contains a cycle.")); break; } ready.forEach((id) => { pending.delete(id); activation.push(id); }); }
  const errors = diagnostics.filter((item) => item.severity === "error"); return { status: errors.length ? "not-ready" : "ready", activationOrder: errors.length ? [] : activation, shutdownOrder: errors.length ? [] : [...activation].reverse(), qualifications, diagnostics };
}
