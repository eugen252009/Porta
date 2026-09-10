import { loadPortaConfig } from "./porta-config.js";
import { createPortaNode } from "./porta-node.js";
import type { PublicIdentity } from "./identity.js";

export interface TargetWorkerOptions {
  readonly targetId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly identityDirectory: string;
  readonly allowedClientIdentities: readonly PublicIdentity[];
  readonly allowedCommands?: readonly string[];
  readonly imageRepository?: string;
  readonly registry?: string;
  readonly pairing?: { consume(token: string): boolean };
  readonly host?: string;
  readonly port?: number;
}

/** Compatibility wrapper: the historical worker entrypoint now composes a full Porta node. */
export async function startTargetWorker(options: TargetWorkerOptions) {
  const node = await createPortaNode(await loadPortaConfig(), {
    target: {
      id: options.targetId,
      workspaceId: options.workspaceId,
      workspaceRoot: options.workspaceRoot,
      repository: "git@github.com:eugen252009/Porta.git",
      identityDirectory: options.identityDirectory,
      allowedClientIdentities: options.allowedClientIdentities,
      ...(options.allowedCommands ? { allowedCommands: options.allowedCommands } : {}),
      ...(options.imageRepository ? { imageRepository: options.imageRepository } : {}),
      ...(options.registry ? { registry: options.registry } : {}),
      ...(options.pairing ? { pairing: options.pairing } : {}),
    },
    factories: { skipModelHealth: true },
  });
  await node.application.start();
  const server = node.targetServer!;
  const address = await server.listen(options.host ?? "127.0.0.1", options.port ?? 0);
  return { ...server, address, target: node.application.localTarget!.target, identity: node.identity.public, close: node.close };
}
