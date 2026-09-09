#!/usr/bin/env node
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPortaApplication } from "./porta-application.js";
import { formatConfigError, loadPortaConfig } from "./porta-config.js";
import { createPortaWebServer } from "./web-server.js";
import { buildInfo } from "./build-info.js";
import { InstanceIdentityStore, LoginService } from "./identity.js";
import { WebAuthnService } from "./webauthn.js";

let application: Awaited<ReturnType<typeof createPortaApplication>> | undefined;
let webServer: ReturnType<typeof createPortaWebServer> | undefined;
try {
  const config = await loadPortaConfig();
  const network = process.argv.includes("--network") || process.env.PORTA_NETWORK === "1";
  const tlsMode = (process.env.PORTA_TLS_MODE ?? "disabled") as "disabled" | "proxy" | "native";
  if (!['disabled', 'proxy', 'native'].includes(tlsMode)) throw new Error(`Invalid PORTA_TLS_MODE: ${tlsMode}`);
  const portFlag = process.argv.findIndex((value) => value === "--port"); const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : config.web?.port ?? 4173;
  const info = buildInfo(); process.stdout.write(`Porta ${info.version} commit=${info.commit.slice(0, 12)} build=${info.buildId} dirty=${info.dirty ?? "unknown"}\n`);
  application = await createPortaApplication(config, { skipModelHealth: true });
  const identity = new InstanceIdentityStore(process.env.PORTA_DATA_DIR ?? ".porta");
  const login = new LoginService(identity);
  const webauthn = new WebAuthnService(process.env.PORTA_DATA_DIR ?? ".porta", { rpID: process.env.PORTA_WEBAUTHN_RP_ID ?? "localhost", rpName: process.env.PORTA_WEBAUTHN_RP_NAME ?? "Porta", origin: process.env.PORTA_WEBAUTHN_ORIGIN ?? `http://localhost:${process.env.PORTA_WEB_PORT ?? port}` });
  const uiSessions = new Map<string, number>();
  await application.start();
  webServer = createPortaWebServer({ ...application, identity, login, webauthn, uiSessions }, { port: Number(process.env.PORTA_WEB_PORT ?? port), host: network ? "0.0.0.0" : "127.0.0.1", targets: (config.web?.targets ?? []).map((target) => ({ id: target.id, displayName: target.name, kind: "remote" as const, endpoint: target.endpoint })), webRoot: join(dirname(fileURLToPath(import.meta.url)), "../../web"), tls: { mode: tlsMode, certificatePath: process.env.PORTA_TLS_CERT, privateKeyPath: process.env.PORTA_TLS_KEY } });
  await webServer.listen();
  process.stdout.write(`${tlsMode === "native" ? "HTTPS" : "HTTP"} listener: ${network ? "0.0.0.0" : "127.0.0.1"}:${process.env.PORTA_WEB_PORT ?? port}\nTLS mode: ${tlsMode}${tlsMode === "native" ? "\nHTTP/2: enabled" : ""}\nWebAuthn origin: ${process.env.PORTA_WEBAUTHN_ORIGIN ?? `${tlsMode === "native" ? "https" : "http"}://localhost:${process.env.PORTA_WEB_PORT ?? port}`}\n`);
  await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
} catch (error) {
  process.stderr.write(`Porta web startup failed.\n${error instanceof Error ? error.message : formatConfigError(error)}\n`);
  process.exitCode = 1;
} finally {
  await webServer?.close();
  await application?.shutdown();
}
