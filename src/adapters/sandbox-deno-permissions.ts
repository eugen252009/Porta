import { z } from "zod";
import { ExecutionPolicy, HarnessPlugin, SandboxBinding, SandboxCapabilities, SandboxProvider, SandboxSession } from "../contracts.js";
import { executionId } from "../runtime.js";

export const denoPermissionBindingKind = "deno.permissions/v1";
export const denoPermissionPayloadSchema = z.object({ filesystem: z.enum(["allow", "deny"]), network: z.enum(["allow", "deny"]) });
export type DenoPermissionPayload = z.infer<typeof denoPermissionPayloadSchema>;
export interface DenoPermissionSandboxConfig { readonly bindingKind?: string }
export const denoPermissionSandboxConfigSchema = z.object({ bindingKind: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\/v\d+$/).optional() });

export function mapExecutionPolicyToDenoPermissions(policy: ExecutionPolicy): DenoPermissionPayload { return { filesystem: policy.filesystem === "allow" ? "allow" : "deny", network: policy.network === "allow" ? "allow" : "deny" }; }

class DenoSandboxSession implements SandboxSession {
  readonly id = executionId(); disposed = false;
  constructor(readonly binding: SandboxBinding) {}
  async dispose(): Promise<void> { this.disposed = true; }
}

export class DenoPermissionSandbox implements SandboxProvider {
  readonly descriptor = { id: "sandbox.deno-permissions", version: "1" };
  readonly capabilities: SandboxCapabilities = { filesystem: "native", network: "native", codeLoading: "unsupported" };
  readonly bindingKind: string;
  constructor(config: DenoPermissionSandboxConfig = {}) { this.bindingKind = denoPermissionSandboxConfigSchema.parse(config).bindingKind ?? denoPermissionBindingKind; }
  async create(policy: ExecutionPolicy): Promise<SandboxSession> { const payload = denoPermissionPayloadSchema.parse(mapExecutionPolicyToDenoPermissions(policy)); return new DenoSandboxSession({ schemaVersion: 1, kind: this.bindingKind, payload }); }
}

export function denoPermissionSandboxPlugin(sandbox: DenoPermissionSandbox): HarnessPlugin { return { manifest: { schemaVersion: 1, id: "sandbox.deno-permissions", version: "1", provides: [{ id: "sandbox.filesystem", version: "1" }, { id: "sandbox.network", version: "1" }], requires: [{ capability: "runtime.binding.deno-permissions.v1" }] }, register(registrar) { registrar.provide({ id: "sandbox.filesystem", version: "1" }, sandbox); registrar.provide({ id: "sandbox.network", version: "1" }, sandbox); } }; }
