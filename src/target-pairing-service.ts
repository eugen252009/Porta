import type { PortaConfig } from "./porta-config.js";
import { savePortaConfig } from "./porta-config.js";
import { HttpTargetTransport } from "./target-transport.js";
import { InstanceIdentityStore } from "./identity.js";
import { RemoteDevelopmentReleaseTarget, RemoteExecutionTarget, TargetRegistry } from "./target.js";
import type { PairingPayload } from "./target-pairing.js";

export class TargetPairingService {
  constructor(private readonly config: PortaConfig, private readonly registry: TargetRegistry, private readonly hostIdentity: InstanceIdentityStore) {}
  async pair(payload: PairingPayload): Promise<{ readonly targetId: string; readonly workspaceId: string; readonly endpoint: string; readonly identityFingerprint: string }> {
    if (payload.version !== 1 || payload.type !== "porta-target-pairing" || Date.now() >= Date.parse(payload.expiresAt) || !/^https?:\/\//.test(payload.endpoint)) throw new Error("TARGET_PAIRING_INVALID");
    if (this.registry.resolve(payload.targetId)) throw new Error(`Target '${payload.targetId}' is already registered.`);
    const challengeResponse = await fetch(new URL("/target/pair/challenge", payload.endpoint), { method: "POST" });
    const challenge = await challengeResponse.json() as Parameters<InstanceIdentityStore["sign"]>[0];
    if (!challengeResponse.ok || !challenge.challengeId) throw new Error("TARGET_PAIRING_CHALLENGE_FAILED");
    const response = await fetch(new URL("/target/pair", payload.endpoint), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, type: payload.type, targetId: payload.targetId, workspaceId: payload.workspaceId, pairingToken: payload.pairingToken, challengeId: challenge.challengeId, signature: this.hostIdentity.sign(challenge), orchestrator: this.hostIdentity.public }) });
    const result = await response.json() as { error?: string; target?: { id: string; workspace?: { id: string; path: string }; capabilities: readonly string[] }; identity?: { identity: string } };
    if (!response.ok || !result.target || !result.identity) throw new Error(result.error ?? "TARGET_PAIRING_FAILED");
    if (result.target.id !== payload.targetId || result.target.workspace?.id !== payload.workspaceId || result.identity.identity !== `porta:ed25519:${payload.identityFingerprint}`) throw new Error("TARGET_PAIRING_IDENTITY_MISMATCH");
    const remote = new RemoteExecutionTarget(payload.targetId, "remote", new HttpTargetTransport({ endpoint: payload.endpoint, clientIdentity: this.hostIdentity }), payload.workspaceId);
    if (this.config.deployment) remote.release = new RemoteDevelopmentReleaseTarget(remote, this.config.deployment.imageRepository, this.config.deployment.registry);
    this.registry.register(remote);
    const existing = this.config.executionTargets ?? [];
    const next = { ...this.config, executionTargets: [...existing, { id: payload.targetId, kind: "remote", transport: "http" as const, endpoint: payload.endpoint, workspaceId: payload.workspaceId }] };
    await savePortaConfig(next, process.env.PORTA_CONFIG ?? "porta.json");
    return { targetId: payload.targetId, workspaceId: payload.workspaceId, endpoint: payload.endpoint, identityFingerprint: payload.identityFingerprint };
  }
}
