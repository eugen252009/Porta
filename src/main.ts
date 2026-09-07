#!/usr/bin/env node
import process from "node:process";
import { createPortaApplication } from "./porta-application.js";
import { HarnessFailure } from "./contracts.js";
import { existsSync } from "node:fs";
import { formatConfigError, loadPortaConfig, savePortaConfig } from "./porta-config.js";
import { TerminalInputAdapter, TerminalRenderer, runTerminal } from "./terminal.js";

import { ModelPicker } from "./model-picker.js";

let application: Awaited<ReturnType<typeof createPortaApplication>> | undefined;
try {
  let config = await loadPortaConfig();
  const forcePicker = process.argv.includes("--picker");
  const skipPicker = process.argv.includes("--no-picker");
  const hasConfigFile = existsSync("porta.json") || existsSync(".porta/config.json") || Boolean(process.env.PORTA_CONFIG);
  const isInteractive = Boolean(process.stdin.isTTY) && !skipPicker;

  let attempts = 0;
  while (true) {
    try {
      if (forcePicker || (isInteractive && !hasConfigFile && attempts === 0) || (isInteractive && attempts > 0)) {
        const selectedModelConfig = await ModelPicker.promptInteractive(config);
        config = {
          ...config,
          model: selectedModelConfig,
        };
        await savePortaConfig(config);
        process.stdout.write("Saved configuration to porta.json\n");
      }
      application = await createPortaApplication(config);
      await application.start();
      break;
    } catch (error) {
      if ((isInteractive || forcePicker) && !skipPicker && attempts < 3) {
        attempts++;
        const msg = error instanceof HarnessFailure ? error.error.message : formatConfigError(error);
        process.stderr.write(`\nPorta startup failed: ${msg}\nPlease select another model provider or configuration.\n`);
        continue;
      }
      throw error;
    }
  }

  process.stdout.write(`Model: ${config.model.model}\n\n`);
  const sessionFlag = process.argv.findIndex((value) => value === "--session"); const resumeSessionId = sessionFlag >= 0 ? process.argv[sessionFlag + 1] : process.env.PORTA_SESSION;
  if (sessionFlag >= 0 && !resumeSessionId) throw new Error("--session requires a session ID.");
  await runTerminal(application.gateway, new TerminalInputAdapter(process.stdin), new TerminalRenderer(process.stdout), process.stdout, resumeSessionId);
} catch (error) {
  process.stderr.write(`Porta startup failed.\n${error instanceof HarnessFailure ? error.error.message : formatConfigError(error)}\n`);
  process.exitCode = 1;
} finally { await application?.shutdown(); }
