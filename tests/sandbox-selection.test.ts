import { describe, expect, it } from "vitest";
import { ExecutionPolicy, SandboxProvider } from "../src/contracts.js";
import { selectSandbox } from "../src/sandbox-selection.js";

const policy: ExecutionPolicy = { filesystem: "best-effort", network: "deny", codeLoading: "best-effort" };
function sandbox(id: string, capabilities: SandboxProvider["capabilities"]): SandboxProvider { return { descriptor: { id, version: "1" }, capabilities, async create() { return { id: `${id}-session`, async dispose() {} }; } }; }
const host = sandbox("sandbox.host-process", { filesystem: "best-effort", network: "unsupported", codeLoading: "unsupported" });
const strong = sandbox("sandbox.external", { filesystem: "external", network: "external", codeLoading: "unsupported" });

describe("sandbox selection", () => {
  it("prefers the strongest compatible backend deterministically", async () => { const selected = await selectSandbox(policy, [{ provider: host }, { provider: strong }]); expect(selected.provider).toBe(strong); expect(selected.candidates).toEqual([host.descriptor.id, strong.descriptor.id]); });
  it("fails closed when the only backend cannot enforce a required restriction", async () => { await expect(selectSandbox(policy, [{ provider: host }])).rejects.toMatchObject({ error: { code: "POLICY_VIOLATION" } }); });
  it("uses a permitted weaker backend and respects explicit preference", async () => { const weakPolicy = { ...policy, network: "best-effort" as const }; expect((await selectSandbox(weakPolicy, [{ provider: strong }, { provider: host }], [host.descriptor.id])).provider).toBe(host); });
  it("does not select unavailable backends", async () => { const selected = await selectSandbox(weakPolicy(), [{ provider: strong, available: async () => false }, { provider: host }]); expect(selected.provider).toBe(host); });
});
function weakPolicy(): ExecutionPolicy { return { filesystem: "best-effort", network: "best-effort", codeLoading: "best-effort" }; }
