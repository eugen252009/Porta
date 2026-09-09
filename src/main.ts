#!/usr/bin/env node
import process from "node:process";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPortaApplication } from "./porta-application.js";
import { HarnessFailure } from "./contracts.js";
import { existsSync } from "node:fs";
import { formatConfigError, loadPortaConfig, savePortaConfig } from "./porta-config.js";
import { TerminalInputAdapter, TerminalRenderer, runTerminal } from "./terminal.js";
import { runCodexAuthCommand } from "./codex-auth-cli.js";
import { ModelPicker } from "./model-picker.js";
import { runDoctor } from "./doctor.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("Porta\n\nUsage:\n  porta [--picker] [--session <id>]\n  porta tui [--session <id>]\n  porta web\n  porta login <provider>\n  porta doctor [--verbose|--json]\n");
  process.exitCode = 0;
}
const subcommand = args[0];
if (process.exitCode === 0 && (args.includes("--help") || args.includes("-h"))) {
  // Help was already written above; do not initialize a model or frontend.
} else if (subcommand === "doctor") {
  process.exitCode = await runDoctor(args.slice(1));
} else if (subcommand === "tui" || subcommand === "web" || subcommand === "serve") {
  process.exitCode = await runFrontend(subcommand, args.slice(1));
} else {
  await runCli(args);
}

async function runFrontend(name: "tui" | "web" | "serve", args: readonly string[]): Promise<number> {
  const entry = join(dirname(fileURLToPath(import.meta.url)), name === "tui" ? "main-tui.js" : "main-web.js");
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: "inherit" });
    child.once("error", (error) => { process.stderr.write(`Porta ${name} failed to start: ${error.message}\n`); resolve(1); });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function runCli(args: readonly string[]): Promise<void> {
  let application: Awaited<ReturnType<typeof createPortaApplication>> | undefined;
  try {
    if (!await runCodexAuthCommand(args)) {
      let config = await loadPortaConfig();
      const forcePicker = args.includes("--picker"); const skipPicker = args.includes("--no-picker");
      const hasConfigFile = existsSync("porta.json") || existsSync(".porta/config.json") || Boolean(process.env.PORTA_CONFIG);
      const isInteractive = Boolean(process.stdin.isTTY) && !skipPicker;
      let attempts = 0;
      while (true) {
        try {
          if (forcePicker || (isInteractive && !hasConfigFile && attempts === 0) || (isInteractive && attempts > 0)) { config = { ...config, model: await ModelPicker.promptInteractive(config) }; await savePortaConfig(config); process.stdout.write("Saved configuration to porta.json\n"); }
          application = await createPortaApplication(config); await application.start(); break;
        } catch (error) {
          if ((isInteractive || forcePicker) && !skipPicker && attempts < 3) { attempts++; const msg = error instanceof HarnessFailure ? error.error.message : formatConfigError(error); process.stderr.write(`\nPorta startup failed: ${msg}\nPlease select another model provider or configuration.\n`); continue; }
          throw error;
        }
      }
      const renderer = new TerminalRenderer(process.stdout); renderer.renderStartup(config.model.model, application.toolRouter.listTools().map((tool) => tool.canonicalId));
      const sessionFlag = args.findIndex((value) => value === "--session"); const resumeSessionId = sessionFlag >= 0 ? args[sessionFlag + 1] : process.env.PORTA_SESSION;
      if (sessionFlag >= 0 && !resumeSessionId) throw new Error("--session requires a session ID.");
      await runTerminal(application.gateway, new TerminalInputAdapter(process.stdin), renderer, process.stdout, resumeSessionId);
    }
  } catch (error) { process.stderr.write(`Porta startup failed.\n${error instanceof HarnessFailure ? error.error.message : formatConfigError(error)}\n`); process.exitCode = 1; }
  finally { await application?.shutdown(); }
}
