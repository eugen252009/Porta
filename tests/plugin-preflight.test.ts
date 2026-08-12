import { describe, expect, it } from "vitest";
import { HarnessPlugin, PluginEnvironmentSnapshot, PluginManager, planPlugins, qualifyPlugin, validatePluginManifest, mockRuntimePlugin, mockSandboxPlugin } from "../src/index.js";

const manifest = (id: string, provides: string[] = [], requires: { capability: string; optional?: boolean }[] = []): HarnessPlugin["manifest"] => ({ schemaVersion: 1, id, version: "1", provides: provides.map((capability) => ({ id: capability, version: "1" })), requires });
const environment = (plugins: HarnessPlugin["manifest"][] = []): PluginEnvironmentSnapshot => ({ availableCapabilities: [], plugins });

describe("plugin preflight", () => {
  it("validates structural manifest rules", () => {
    expect(validatePluginManifest(manifest("valid", ["cap.one"])).valid).toBe(true);
    expect(validatePluginManifest({ ...manifest("Bad ID"), schemaVersion: 1 }).errors[0]!.code).toBe("PLUGIN_ID_INVALID");
    expect(validatePluginManifest({ ...manifest("valid", ["cap.one", "cap.one"]) }).errors[0]!.code).toBe("PLUGIN_CAPABILITY_DUPLICATE");
    expect(validatePluginManifest({ ...manifest("valid", [], [{ capability: "cap.one" }, { capability: "cap.one", optional: true }]) }).errors[0]!.code).toBe("PLUGIN_REQUIREMENT_INVALID");
    expect(validatePluginManifest({ ...manifest("valid"), schemaVersion: 2 }).errors[0]!.code).toBe("PLUGIN_SCHEMA_VERSION_UNSUPPORTED");
  });
  it("qualifies required and optional capabilities", () => {
    const provider = manifest("provider", ["cap.available"]);
    expect(qualifyPlugin(manifest("required", [], [{ capability: "cap.available" }]), environment([provider])).status).toBe("loadable");
    const optional = qualifyPlugin(manifest("optional", [], [{ capability: "cap.missing", optional: true }]), environment());
    expect(optional.status).toBe("loadable-with-warnings"); expect(optional.warnings[0]!.code).toBe("PLUGIN_OPTIONAL_CAPABILITY_MISSING");
    expect(qualifyPlugin(manifest("required", [], [{ capability: "cap.missing" }]), environment()).status).toBe("not-loadable");
  });
  it("plans chains independently of registration order", () => {
    const a = manifest("a", ["cap.a"]); const b = manifest("b", ["cap.b"], [{ capability: "cap.a" }]); const c = manifest("c", [], [{ capability: "cap.b" }]);
    const plan = planPlugins([c, a, b]); expect(plan.status).toBe("ready"); expect(plan.activationOrder).toEqual(["a", "b", "c"]); expect(plan.shutdownOrder).toEqual(["c", "b", "a"]);
  });
  it("uses lexical ordering for independent plugins", () => { expect(planPlugins([manifest("z"), manifest("a")]).activationOrder).toEqual(["a", "z"]); });
  it("rejects cycles and incompatible providers", () => {
    const a = manifest("a", ["cap.a"], [{ capability: "cap.b" }]); const b = manifest("b", ["cap.b"], [{ capability: "cap.a" }]);
    expect(planPlugins([a, b]).diagnostics.some((diagnostic) => diagnostic.code === "PLUGIN_DEPENDENCY_CYCLE")).toBe(true);
    const one = { ...manifest("one", ["cap.same"]), provides: [{ id: "cap.same", version: "1" }] }; const two = { ...manifest("two", ["cap.same"]), provides: [{ id: "cap.same", version: "2" }] };
    expect(planPlugins([one, two]).diagnostics.some((diagnostic) => diagnostic.code === "PLUGIN_CAPABILITY_CONFLICT")).toBe(true);
  });
  it("does not execute plugin code during qualification", () => {
    let calls = 0; const plugin = { manifest: manifest("safe", ["cap.safe"]), register: () => { calls++; }, initialize: async () => { calls++; }, start: async () => { calls++; } };
    const plan = planPlugins([plugin.manifest]); expect(plan.status).toBe("ready"); expect(calls).toBe(0);
    const manager = { planPlugins: () => plan }; expect(manager.planPlugins()).toBe(plan);
  });
  it("activates a dependency chain using the validated plan", async () => {
    const order: string[] = [];
    const make = (id: string, provides: string[], requires: { capability: string }[] = []) => ({ manifest: manifest(id, provides, requires), register: () => { order.push(`register:${id}`); }, initialize: async () => { order.push(`initialize:${id}`); }, start: async () => { order.push(`start:${id}`); }, stop: async () => { order.push(`stop:${id}`); } });
    const a = make("a", ["cap.a"]); const b = make("b", ["cap.b"], [{ capability: "cap.a" }]); const c = make("c", [], [{ capability: "cap.b" }]); const manager = new PluginManager();
    await manager.register([c, a, b]); await manager.stop([c, a, b]);
    expect(order).toEqual(["register:a", "register:b", "register:c", "initialize:a", "initialize:b", "initialize:c", "start:a", "start:b", "start:c", "stop:c", "stop:b", "stop:a"]);
  });
  it("does not activate an invalid plan", async () => {
    let calls = 0; const plugin = { manifest: manifest("missing", [], [{ capability: "cap.absent" }]), register: () => { calls++; }, initialize: async () => { calls++; }, start: async () => { calls++; } }; const manager = new PluginManager();
    await expect(manager.register([plugin])).rejects.toThrow(); expect(calls).toBe(0);
  });
  it("qualifies runtime and sandbox mock plugins through generic capabilities", () => { const plan = planPlugins([mockRuntimePlugin({} as never).manifest, mockSandboxPlugin({} as never).manifest]); expect(plan.status).toBe("ready"); expect(plan.activationOrder).toEqual(["runtime.mock", "sandbox.mock"]); });
});
