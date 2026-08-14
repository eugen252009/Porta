#!/usr/bin/env node
import process from "node:process";
import { createHarnessApplication } from "./harness-application.js";
import { HarnessFailure } from "./contracts.js";
import { formatConfigError, loadHarnessConfig } from "./harness-config.js";
import { TerminalInputAdapter, TerminalRenderer, runTerminal } from "./terminal.js";

let application: Awaited<ReturnType<typeof createHarnessApplication>> | undefined;
try {
  const config = await loadHarnessConfig();
  application = await createHarnessApplication(config);
  await application.start();
  process.stdout.write(`Model: ${config.model.model}\n\n`);
  await runTerminal(application.gateway, new TerminalInputAdapter(process.stdin), new TerminalRenderer(process.stdout), process.stdout);
} catch (error) {
  process.stderr.write(`Harness startup failed.\n${error instanceof HarnessFailure ? error.error.message : formatConfigError(error)}\n`);
  process.exitCode = 1;
} finally { await application?.shutdown(); }
