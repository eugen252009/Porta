import { createPortaApplication, type PortaApplication, type PortaFactories, type PortaTargetCapabilityOptions } from "./porta-application.js";
import { InstanceIdentityStore, type PublicIdentity } from "./identity.js";
import { createTargetTransportServer, type TargetTransportServerOptions } from "./target-transport.js";
import { parsePortaConfig, type PortaConfig } from "./porta-config.js";
import type { PairingSession } from "./target-pairing.js";
import { NodeDelegationService } from "./node-delegation.js";
import { createNodeApplicationProtocol } from "./remote-application.js";

export interface PortaNodeTargetOptions extends PortaTargetCapabilityOptions {
  readonly identityDirectory: string;
  readonly allowedClientIdentities?: readonly PublicIdentity[];
  readonly pairing?: Pick<PairingSession, "consume">;
  readonly host?: string;
  readonly port?: number;
}

export interface PortaNodeOptions {
  readonly identity?: InstanceIdentityStore;
  readonly identityDirectory?: string;
  readonly target?: PortaNodeTargetOptions;
  readonly factories?: Omit<PortaFactories, "identity" | "target">;
}

export interface PortaNode {
  readonly application: PortaApplication;
  readonly identity: InstanceIdentityStore;
  readonly targetServer?: ReturnType<typeof createTargetTransportServer>;
  readonly delegation?: NodeDelegationService;
  close(): Promise<void>;
}

/**
 * Composes one local Porta application and optional node-facing protocols.
 * Target capability is additive; it does not create a second application.
 */
export async function createPortaNode(config: PortaConfig, options: PortaNodeOptions = {}): Promise<PortaNode> {
  const target = options.target;
  const nodeConfig = target ? configForTargetNode(config, target) : config;
  const identity = options.identity ?? new InstanceIdentityStore(options.identityDirectory ?? target?.identityDirectory ?? process.env.PORTA_DATA_DIR ?? ".porta");
  const application = await createPortaApplication(nodeConfig, {
    ...options.factories,
    identity,
    ...(target ? { target } : {}),
  });
  let targetServer: ReturnType<typeof createTargetTransportServer> | undefined;
  const delegation = target ? new NodeDelegationService(application.delegatedTasks) : undefined;
  if (target) {
    if (!application.localTarget) throw new Error("Target capability was not composed.");
    const serverOptions: TargetTransportServerOptions = {
      target: application.localTarget.target,
      identity,
      operations: application.localTarget.operations,
      ...(target.allowedClientIdentities ? { allowedIdentities: target.allowedClientIdentities } : {}),
      ...(target.pairing ? { pairing: target.pairing } : {}),
      ...(delegation ? { delegation } : {}),
      application: createNodeApplicationProtocol(application),
    };
    targetServer = createTargetTransportServer(serverOptions);
  }
  return {
    application,
    identity,
    ...(targetServer ? { targetServer } : {}),
    ...(delegation ? { delegation } : {}),
    async close() {
      await targetServer?.close();
      await application.shutdown();
    },
  };
}

function configForTargetNode(config: PortaConfig, target: PortaNodeTargetOptions): PortaConfig {
  const execution = config.execution as NonNullable<PortaConfig["execution"]> | undefined;
  const filesystem = config.filesystem as NonNullable<PortaConfig["filesystem"]> | undefined;
  const git = config.git as NonNullable<PortaConfig["git"]> | undefined;
  return parsePortaConfig({
    ...config,
    filesystem: { ...(filesystem ?? {}), root: target.workspaceRoot, mutation: { ...(filesystem?.mutation ?? {}), enabled: true } },
    execution: { ...(execution ?? {}), enabled: true, allowedCommands: target.allowedCommands?.length ? target.allowedCommands : execution?.allowedCommands?.length ? execution.allowedCommands : ["node", "npm", "git", "docker"] },
    git: { ...git, enabled: true },
    ...(target.imageRepository && target.registry ? { deployment: config.deployment ?? { imageRepository: target.imageRepository, registry: target.registry, target: "porta-nas" } } : {}),
  });
}
