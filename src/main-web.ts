#!/usr/bin/env node
import process from "node:process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPortaApplication } from "./porta-application.js";
import { formatConfigError, loadPortaConfig } from "./porta-config.js";
import { createPortaWebServer } from "./web-server.js";
import { buildInfo } from "./build-info.js";
import { LoginService } from "./identity.js";
import { WebAuthnService } from "./webauthn.js";
import { PluginManager } from "./kernel.js";
import { createHomeAuthAdmissionPlugin, HomeAuthAdmissionAuthenticator, homeAuthPublicKey } from "./adapters/auth-homeauth.js";
import type { HarnessPlugin, RequestAuthenticator } from "./contracts.js";

let application: Awaited<ReturnType<typeof createPortaApplication>> | undefined;
let webServer: ReturnType<typeof createPortaWebServer> | undefined;
let apiServer: ReturnType<typeof createPortaWebServer> | undefined;
const pluginManager = new PluginManager();
const plugins: HarnessPlugin[] = [];
try {
  const config = await loadPortaConfig();
  const network = process.argv.includes("--network") || process.env.PORTA_NETWORK === "1";
  const tlsMode = (process.env.PORTA_TLS_MODE ?? "disabled") as "disabled" | "proxy" | "native";
  if (!['disabled', 'proxy', 'native'].includes(tlsMode)) throw new Error(`Invalid PORTA_TLS_MODE: ${tlsMode}`);
  const portFlag = process.argv.findIndex((value) => value === "--port"); const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : config.web?.port ?? 4173;
  const info = buildInfo(); process.stdout.write(`Porta ${info.version} commit=${info.commit.slice(0, 12)} build=${info.buildId} dirty=${info.dirty ?? "unknown"}\n`);
  application = await createPortaApplication(config, { skipModelHealth: true });
  const identity = application.identity;
  const login = new LoginService(identity);
  const webauthn = new WebAuthnService(process.env.PORTA_DATA_DIR ?? ".porta", { rpID: process.env.PORTA_WEBAUTHN_RP_ID ?? "localhost", rpName: process.env.PORTA_WEBAUTHN_RP_NAME ?? "Porta", origin: process.env.PORTA_WEBAUTHN_ORIGIN ?? `http://localhost:${process.env.PORTA_WEB_PORT ?? port}` });
  const uiSessions = new Map<string, number>();
  const homeAuthKeyPath = process.env.HOMEAUTH_PUBLIC_KEY;
  const homeAuthServiceId = process.env.HOMEAUTH_SERVICE_ID;
  let requestAuthenticators: readonly RequestAuthenticator[] | undefined;
  if (homeAuthKeyPath || homeAuthServiceId) {
    if (!homeAuthKeyPath || !homeAuthServiceId || !/^(0|[1-9][0-9]*)$/.test(homeAuthServiceId)) throw new Error("HOMEAUTH_PUBLIC_KEY and a valid HOMEAUTH_SERVICE_ID must both be configured.");
    const plugin = createHomeAuthAdmissionPlugin(new HomeAuthAdmissionAuthenticator({ publicKey: homeAuthPublicKey(readFileSync(homeAuthKeyPath, "utf8")), serviceId: BigInt(homeAuthServiceId) }));
    await pluginManager.register([plugin]);
    plugins.push(plugin);
    requestAuthenticators = pluginManager.resolveAll<RequestAuthenticator>({ capability: "auth.request-authentication", version: "1" });
    if (!requestAuthenticators.length) throw new Error("HomeAuth plugin did not provide request authentication.");
  }
  await application.start();
  const serverApplication = { ...application, identity, login, webauthn, uiSessions, ...(requestAuthenticators ? { requestAuthenticators } : {}) };
  webServer = createPortaWebServer(serverApplication, { port: Number(process.env.PORTA_WEB_PORT ?? port), host: network ? "0.0.0.0" : "127.0.0.1", targets: (config.web?.targets ?? []).map((target) => ({ id: target.id, displayName: target.name, kind: "remote" as const, endpoint: target.endpoint })), webRoot: join(dirname(fileURLToPath(import.meta.url)), "../../web"), tls: { mode: tlsMode, certificatePath: process.env.PORTA_TLS_CERT, privateKeyPath: process.env.PORTA_TLS_KEY }, extensionOrigins: (process.env.PORTA_EXTENSION_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean) });
  await webServer.listen();
  const apiListen = process.env.PORTA_LLM_API_LISTEN;
  if (apiListen) {
    const separator = apiListen.lastIndexOf(":");
    if (separator <= 0) throw new Error("PORTA_LLM_API_LISTEN must be host:port");
    const apiHost = apiListen.slice(0, separator);
    const apiPort = Number(apiListen.slice(separator + 1));
    if (!Number.isInteger(apiPort) || apiPort <= 0) throw new Error("PORTA_LLM_API_LISTEN must be host:port");
    const apiAuthentication = process.env.PORTA_LLM_AUTH_MODE ?? "compatible";
    if (apiAuthentication !== "compatible" && apiAuthentication !== "required") throw new Error("Invalid PORTA_LLM_AUTH_MODE.");
    apiServer = createPortaWebServer(serverApplication, { port: apiPort, host: apiHost, apiOnly: true, apiAuthentication, tls: { mode: "disabled" } });
    await apiServer.listen();
  }
  process.stdout.write(`${tlsMode === "native" ? "HTTPS" : "HTTP"} listener: ${network ? "0.0.0.0" : "127.0.0.1"}:${process.env.PORTA_WEB_PORT ?? port}\nTLS mode: ${tlsMode}${tlsMode === "native" ? "\nHTTP/2: enabled" : ""}\nWebAuthn origin: ${process.env.PORTA_WEBAUTHN_ORIGIN ?? `${tlsMode === "native" ? "https" : "http"}://localhost:${process.env.PORTA_WEB_PORT ?? port}`}\n`);
  await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
} catch (error) {
  process.stderr.write(`Porta web startup failed.\n${error instanceof Error ? error.message : formatConfigError(error)}\n`);
  process.exitCode = 1;
} finally {
  await apiServer?.close();
  await webServer?.close();
  await application?.shutdown();
  if (plugins.length) await pluginManager.stop(plugins);
}
