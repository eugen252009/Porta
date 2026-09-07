import { createInterface } from "node:readline/promises";
import process from "node:process";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { CodexAuth } from "./adapters/codex-auth.js";
import { failure, HarnessFailure } from "./contracts.js";

export interface CodexAuthCommands {
  login(interaction: AuthInteraction): Promise<void>;
  logout(signal?: AbortSignal): Promise<void>;
}

/** Runs before model configuration/application startup; auth never passes through a model or web client. */
export async function runCodexAuthCommand(
  args: readonly string[],
  dependencies: { auth?: CodexAuthCommands; interaction?: AuthInteraction; write?: (text: string) => void } = {},
): Promise<boolean> {
  const [command, provider, option] = args;
  if (command !== "login" && command !== "logout") return false;
  if (provider !== "openai-codex" || args.length > 3 || (option !== undefined && (command !== "login" || option !== "--device-code"))) {
    throw failure("VALIDATION_FAILED", "Usage: porta login openai-codex [--device-code] | porta logout openai-codex");
  }
  if (command === "login" && option !== "--device-code" && process.env.PI_OAUTH_CALLBACK_HOST && process.env.PI_OAUTH_CALLBACK_HOST !== "127.0.0.1") {
    throw failure("VALIDATION_FAILED", "Codex browser login requires a loopback callback. Unset PI_OAUTH_CALLBACK_HOST or use --device-code.");
  }
  const auth = dependencies.auth ?? new CodexAuth();
  const write = dependencies.write ?? ((text: string) => { process.stdout.write(text); });
  const control = new AbortController();
  const abort = () => control.abort();
  const timer = setTimeout(abort, 15 * 60 * 1000);
  process.once("SIGINT", abort);
  let readline: ReturnType<typeof createInterface> | undefined;
  const signal = dependencies.interaction?.signal ? AbortSignal.any([control.signal, dependencies.interaction.signal]) : control.signal;
  const interaction: AuthInteraction = {
    signal,
    async prompt(prompt) {
      if (prompt.type === "select") return option === "--device-code" ? "device_code" : "browser";
      if (dependencies.interaction) return dependencies.interaction.prompt(prompt);
      readline ??= createInterface({ input: process.stdin, output: process.stdout });
      readline.once("close", abort);
      const answer = await readline.question(`${prompt.message}\n> `, { signal: prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal });
      if (!answer.trim()) throw failure("CANCELLED", "Codex login cancelled.");
      return answer.trim();
    },
    notify(event) {
      if (dependencies.interaction) { dependencies.interaction.notify(event); return; }
      if (event.type === "auth_url") write(`Open this URL in your browser:\n${event.url}\n${event.instructions ?? ""}\n`);
      else if (event.type === "device_code") write(`Open ${event.verificationUri} and enter code: ${event.userCode}\n`);
      else write(`${event.message}\n`);
    },
  };
  try {
    if (command === "login") await auth.login(interaction);
    else await auth.logout(signal);
    write(command === "login" ? "Signed in to OpenAI Codex.\n" : "Removed Porta's local Codex credentials (not server-side token revocation).\n");
    return true;
  } catch (error) {
    if (signal.aborted) throw failure("CANCELLED", "Codex authentication cancelled or timed out.");
    if (error instanceof HarnessFailure) throw error;
    throw failure("AUTHORIZATION_DENIED", "Codex authentication failed. Retry login; check the private auth directory if the problem persists.");
  } finally { clearTimeout(timer); process.removeListener("SIGINT", abort); readline?.close(); }
}
