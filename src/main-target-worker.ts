#!/usr/bin/env node
import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { loadPortaConfig } from "./porta-config.js";
import { createPortaNode } from "./porta-node.js";
import { PairingSession, pairingFingerprint, pairingUrl, type PairingPayload } from "./target-pairing.js";

const args = process.argv.slice(2);
const value = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const identityDirectory = value("--identity-dir") ?? process.env.PORTA_TARGET_IDENTITY_DIR ?? `${process.env.HOME ?? process.cwd()}/.porta-target-worker`;
const allowedPath = value("--allowed-identities") ?? process.env.PORTA_TARGET_ALLOWED_IDENTITIES_FILE ?? `${identityDirectory}/allowed-identities.json`;
const allowed = await (async () => { try { return JSON.parse(await readFile(allowedPath, "utf8")) as readonly { readonly identity: string; readonly publicKey: string; readonly algorithm: "ed25519" }[]; } catch { return []; } })();
const pairing = args.includes("--pair") || allowed.length === 0 ? new PairingSession() : undefined;
const targetId = value("--target-id") ?? process.env.PORTA_TARGET_ID ?? "pc-main";
const workspaceId = value("--workspace-id") ?? process.env.PORTA_TARGET_WORKSPACE_ID ?? "porta-main";
const workspaceRoot = value("--workspace") ?? process.env.PORTA_TARGET_WORKSPACE ?? process.cwd();
const host = value("--host") ?? process.env.PORTA_TARGET_HOST ?? "0.0.0.0";
const port = Number(value("--port") ?? process.env.PORTA_TARGET_PORT ?? "0");
const imageRepository = value("--image-repository") ?? process.env.PORTA_IMAGE_REPOSITORY ?? "porta";
const registry = value("--registry") ?? process.env.PORTA_IMAGE_REGISTRY ?? "192.168.188.2:9006";
const node = await createPortaNode(await loadPortaConfig(), { target: { id: targetId, workspaceId, workspaceRoot, identityDirectory, repository: "git@github.com:eugen252009/Porta.git", allowedClientIdentities: allowed, ...(pairing ? { pairing } : {}), imageRepository, registry }, factories: { skipModelHealth: true } });
await node.application.start();
const address = await node.targetServer!.listen(host, port);
const advertisedHost = value("--advertise-host") ?? process.env.PORTA_TARGET_ADVERTISE_HOST ?? discoverHost();
const target = node.application.localTarget!.target;
process.stdout.write(`Porta Target\n\nTarget       ${target.id}\nWorkspace    ${workspaceId}\nEndpoint     http://${advertisedHost}:${address.port}\nIdentity     ${pairingFingerprint(node.identity.public.identity)}\nCapabilities ${target.capabilities.join(", ")}\n`);
if (pairing) { const payload: PairingPayload = { version: 1, type: "porta-target-pairing", targetId: target.id, workspaceId, endpoint: `http://${advertisedHost}:${address.port}`, identityFingerprint: pairingFingerprint(node.identity.public.identity), pairingToken: pairing.secret, expiresAt: pairing.expiresAt }; process.stdout.write(`\nPairing expires ${pairing.expiresAt}\nPairing URL:\n${pairingUrl(payload)}\n\nPairing JSON:\n${JSON.stringify(payload)}\n`); }
process.stdout.write("\nWaiting for authenticated connections...\n");
process.once("SIGINT", async () => { await node.close(); });
process.once("SIGTERM", async () => { await node.close(); });
function discoverHost(): string { for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address; return "127.0.0.1"; }
