import { describe, expect, it } from "vitest";
import { buildBubblewrapArgs } from "../src/adapters/sandbox-bubblewrap.js";
import { evaluateExecutionPolicy } from "../src/runtime.js";
import { MockToolProvider } from "../src/tool-mocks.js";
import { ToolRouter } from "../src/tools.js";
import { parsePortaConfig } from "../src/porta-config.js";
import { AllowAllToolAuthorizationPolicy } from "../src/authorization-mocks.js";
import { inspectSessionCapabilities } from "../src/capability-inspection.js";
import { permissionsForTools, effectivePermissions } from "../src/delegation.js";
import type { ToolContext } from "../src/contracts.js";

const context = (): ToolContext => ({ traceId: "t", sessionId: "s", executionId: "e", signal: new AbortController().signal });

describe("unified capability hardening", () => {
  it("refuses to treat a weak sandbox as enforcement for denied resources", () => {
    expect(evaluateExecutionPolicy({ filesystem: "deny", network: "deny", codeLoading: "deny" }, { filesystem: "best-effort", network: "unsupported", codeLoading: "unsupported" }).allowed).toBe(false);
  });

  it("builds a workspace-only bubblewrap view rather than exposing host root", () => {
    const args = buildBubblewrapArgs("/workspace/project", { filesystem: "allow", network: "deny", codeLoading: "allow" });
    expect(args).toContain("--tmpfs"); expect(args).toContain("/"); expect(args).toContain("--unshare-net");
    expect(args).toEqual(expect.arrayContaining(["--ro-bind", "/", "/", "--tmpfs", "/etc"]));
    expect(args).toEqual(expect.arrayContaining(["--bind", "/workspace/project", "/workspace/project"]));
  });

  it("intersects delegation permissions and does not let a narrowed child regain access", () => {
    const parent = ["agent.delegate", "filesystem.read", "filesystem.write", "network.approval"];
    const child = effectivePermissions(parent, ["filesystem.write"]);
    const grandchild = effectivePermissions(child, ["network.approval"]);
    expect(child).toEqual(["agent.delegate", "filesystem.read", "network.approval"]);
    expect(grandchild).toEqual(["agent.delegate", "filesystem.read"]);
    expect(effectivePermissions(grandchild, ["system.modify"])).toEqual(grandchild);
    expect(permissionsForTools([{ id: "run", name: "execution/run", version: "1", capabilities: ["process.execute"], inputSchema: {} }])).toEqual(["process.execute"]);
  });

  it("exposes effective session capability state without secrets", async () => {
    const router = new ToolRouter(); await router.register("local", new MockToolProvider("local"), context());
    const config = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "fixture" }, filesystem: { root: "/workspace", mutation: { enabled: true } }, execution: { enabled: true, allowedCommands: ["node"], network: "best-effort" }, authorization: { mode: "workspace" } });
    const inspection = await inspectSessionCapabilities("session", config, router, new AllowAllToolAuthorizationPolicy());
    expect(inspection.workspace).toMatchObject({ root: "/workspace", filesystem: "allow" });
    expect(inspection.scratchpad.local).toEqual({ read: "allow", write: "allow" });
    expect(inspection).not.toHaveProperty("credentials");
  });
});
