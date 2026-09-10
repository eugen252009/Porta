#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { startTargetWorker } from "./target-worker.js";
import { PairingSession, pairingFingerprint, pairingUrl, type PairingPayload } from "./target-pairing.js";

const args = process.argv.slice(2);
const value = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const identityDirectory = value("--identity-dir") ?? process.env.PORTA_TARGET_IDENTITY_DIR ?? `${process.env.HOME ?? process.cwd()}/.porta-target-worker`;
const allowedPath = value("--allowed-identities") ?? process.env.PORTA_TARGET_ALLOWED_IDENTITIES_FILE ?? `${identityDirectory}/allowed-identities.json`;
let allowed: readonly { readonly identity: string; readonly publicKey: string; readonly algorithm: "ed25519" }[] = [];
try { allowed = JSON.parse(await readFile(allowedPath, "utf8")) as typeof allowed; } catch {}
const pairing = args.includes("--pair") || allowed.length === 0 ? new PairingSession() : undefined;
const targetId = value("--target-id") ?? process.env.PORTA_TARGET_ID ?? "pc-main";
const workspaceId = value("--workspace-id") ?? process.env.PORTA_TARGET_WORKSPACE_ID ?? "porta-main";
const workspaceRoot = value("--workspace") ?? process.env.PORTA_TARGET_WORKSPACE ?? process.cwd();
const host = value("--host") ?? process.env.PORTA_TARGET_HOST ?? "0.0.0.0";
const port = Number(value("--port") ?? process.env.PORTA_TARGET_PORT ?? "0");
const worker = await startTargetWorker({ targetId, workspaceId, workspaceRoot, identityDirectory, allowedClientIdentities: allowed, pairing, allowedCommands: (process.env.PORTA_TARGET_ALLOWED_COMMANDS ?? "node,npm,git,docker").split(",").filter(Boolean), imageRepository: value("--image-repository") ?? process.env.PORTA_IMAGE_REPOSITORY ?? "porta", registry: value("--registry") ?? process.env.PORTA_IMAGE_REGISTRY ?? "192.168.188.2:9006", host, port });
const advertisedHost = value("--advertise-host") ?? process.env.PORTA_TARGET_ADVERTISE_HOST ?? discoverHost();
process.stdout.write(`Porta Target\n\nTarget       ${worker.target.id}\nWorkspace    ${workspaceId}\nEndpoint     http://${advertisedHost}:${worker.address.port}\nIdentity     ${pairingFingerprint(worker.identity.identity)}\nCapabilities ${worker.target.capabilities.join(", ")}\n`);
if (pairing) { const payload: PairingPayload = { version: 1, type: "porta-target-pairing", targetId: worker.target.id, workspaceId, endpoint: `http://${advertisedHost}:${worker.address.port}`, identityFingerprint: pairingFingerprint(worker.identity.identity), pairingToken: pairing.secret, expiresAt: pairing.expiresAt }; process.stdout.write(`\nPairing expires ${pairing.expiresAt}\nPairing URL:\n${pairingUrl(payload)}\n\nPairing JSON:\n${JSON.stringify(payload)}\n`); }
process.stdout.write("\nWaiting for authenticated connections...\n");
process.once("SIGINT", async () => { await worker.close(); });
process.once("SIGTERM", async () => { await worker.close(); });
function discoverHost(): string { for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address; return "127.0.0.1"; }
