#!/usr/bin/env node
import process from "node:process";
import { createPortaApplication } from "./porta-application.js";
import { formatConfigError, loadPortaConfig } from "./porta-config.js";
import { createPortaWebServer } from "./web-server.js";

let application: Awaited<ReturnType<typeof createPortaApplication>> | undefined;
let webServer: ReturnType<typeof createPortaWebServer> | undefined;
try {
  const config = await loadPortaConfig();
  application = await createPortaApplication(config);
  await application.start();
  webServer = createPortaWebServer(application, { port: Number(process.env.PORTA_WEB_PORT ?? 4173) });
  await webServer.listen();
  process.stdout.write(`Porta web UI: http://127.0.0.1:${process.env.PORTA_WEB_PORT ?? 4173}\n`);
  await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
} catch (error) {
  process.stderr.write(`Porta web startup failed.\n${error instanceof Error ? error.message : formatConfigError(error)}\n`);
  process.exitCode = 1;
} finally {
  await webServer?.close();
  await application?.shutdown();
}
