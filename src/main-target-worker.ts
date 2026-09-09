#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { startTargetWorker } from "./target-worker.js";

const allowedPath = process.env.PORTA_TARGET_ALLOWED_IDENTITIES_FILE;
if (!allowedPath) throw new Error("PORTA_TARGET_ALLOWED_IDENTITIES_FILE is required.");
const allowed = JSON.parse(await readFile(allowedPath, "utf8")) as readonly { readonly identity: string; readonly publicKey: string; readonly algorithm: "ed25519" }[];
const worker = await startTargetWorker({
  targetId: process.env.PORTA_TARGET_ID ?? "pc-main",
  workspaceId: process.env.PORTA_TARGET_WORKSPACE_ID ?? "porta-main",
  workspaceRoot: process.env.PORTA_TARGET_WORKSPACE ?? process.cwd(),
  identityDirectory: process.env.PORTA_TARGET_IDENTITY_DIR ?? `${process.env.HOME ?? process.cwd()}/.porta-target-worker`,
  allowedClientIdentities: allowed,
  allowedCommands: (process.env.PORTA_TARGET_ALLOWED_COMMANDS ?? "node,npm,git,docker").split(",").filter(Boolean),
  host: process.env.PORTA_TARGET_HOST ?? "127.0.0.1",
  port: Number(process.env.PORTA_TARGET_PORT ?? "4180"),
});
process.stdout.write(`Target worker ${worker.target.id} listening on ${worker.address.host}:${worker.address.port}\n`);
process.once("SIGINT", async () => { await worker.close(); });
process.once("SIGTERM", async () => { await worker.close(); });
