#!/usr/bin/env node
import process from "node:process";
import { createPortaApplication } from "./porta-application.js";
import { HarnessFailure } from "./contracts.js";
import { formatConfigError, loadPortaConfig } from "./porta-config.js";
import { TerminalInputAdapter, TerminalRenderer, runTerminal } from "./terminal.js";

let application: Awaited<ReturnType<typeof createPortaApplication>> | undefined;
try {
  const config = await loadPortaConfig();
  application = await createPortaApplication(config);
  await application.start();
  process.stdout.write(`Model: ${config.model.model}\n\n`);
  await runTerminal(application.gateway, new TerminalInputAdapter(process.stdin), new TerminalRenderer(process.stdout), process.stdout);
} catch (error) {
  process.stderr.write(`Porta startup failed.\n${error instanceof HarnessFailure ? error.error.message : formatConfigError(error)}\n`);
  process.exitCode = 1;
} finally { await application?.shutdown(); }
