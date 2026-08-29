#!/usr/bin/env node
import { render } from "ink";
import process from "node:process";
import { createPortaApplication } from "./porta-application.js";
import { HarnessFailure } from "./contracts.js";
import { formatConfigError, loadPortaConfig } from "./porta-config.js";
import { runTui } from "./tui-launcher.js";

let application: Awaited<ReturnType<typeof createPortaApplication>> | undefined;
let sessionId: string | undefined;

try {
  const config = await loadPortaConfig();
  application = await createPortaApplication(config);
  await application.start();

   const sessionFlag = process.argv.findIndex((value) => value === "--session");
   const requestedSessionId = sessionFlag >= 0 ? process.argv[sessionFlag + 1] : process.env.PORTA_SESSION;
   if (sessionFlag >= 0 && !requestedSessionId) throw new Error("--session requires a session ID.");
   sessionId = await runTui(application, config, render, requestedSessionId);

} catch (error) {
  process.stderr.write(`Porta TUI failed.\n${error instanceof HarnessFailure ? error.error.message : error instanceof Error ? error.message : formatConfigError(error)}\n`);
  process.exitCode = 1;
} finally {
  if (application && sessionId) {
    await application.gateway.execute({ type: "CloseSession", sessionId }, {});
  }
  await application?.shutdown();
}
