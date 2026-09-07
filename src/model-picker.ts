import { createInterface } from "node:readline/promises";
import process from "node:process";
import { ModelProvider } from "./contracts.js";
import { PortaConfig } from "./porta-config.js";

export interface ModelPickerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function fetchAvailableModels(
  provider: "ollama" | "openai-compatible" | "openai-codex",
  baseUrl?: string
): Promise<string[]> {
  try {
    if (provider === "ollama") {
      const root = (baseUrl || "http://localhost:11434").replace(/\/+$/, "");
      const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const json = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
        const names = (json.models ?? []).map((m) => m.name || m.model).filter((n): n is string => Boolean(n));
        if (names.length > 0) return names;
      }
    } else if (provider === "openai-compatible") {
      const root = (baseUrl || "http://127.0.0.1:8080").replace(/\/+$/, "");
      const apiRoot = root.endsWith("/v1") ? root : `${root}/v1`;
      const res = await fetch(`${apiRoot}/models`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const json = (await res.json()) as { data?: Array<{ id?: string }> };
        const names = (json.data ?? []).map((m) => m.id).filter((n): n is string => Boolean(n));
        if (names.length > 0) return names;
      }
    } else if (provider === "openai-codex") {
      return ["gpt-5.6-sol", "gpt-4o", "o3-mini", "gpt-4o-mini"];
    }
  } catch {
    // If fetching times out or fails, return empty list
  }
  return [];
}

export class ModelPicker {
  private readonly providers: Record<string, ModelProvider>;

  constructor(providers: Record<string, ModelProvider> = {}) {
    this.providers = providers;
  }

  async selectProvider(preferredProvider?: string): Promise<ModelProvider> {
    if (preferredProvider && this.providers[preferredProvider]) {
      return this.providers[preferredProvider]!;
    }
    const providerKeys = Object.keys(this.providers);
    if (providerKeys.length === 0) {
      throw new Error("No model providers available. Please configure at least one.");
    }

    const firstKey = providerKeys[0];
    if (!firstKey || !this.providers[firstKey]) {
      throw new Error("No model provider found.");
    }
    return this.providers[firstKey]!;
  }

  static async promptInteractive(
    currentConfig: PortaConfig,
    options: ModelPickerOptions = {}
  ): Promise<PortaConfig["model"]> {
    const input = (options.input ?? process.stdin) as NodeJS.ReadableStream;
    const output = (options.output ?? process.stdout) as NodeJS.WritableStream;
    const rl = createInterface({ input, output, terminal: false });
    const linesIterator = rl[Symbol.asyncIterator]();
    const ask = async (promptText: string): Promise<string> => {
      output.write(promptText);
      const res = await linesIterator.next();
      return res.done ? "" : (res.value ?? "");
    };

    try {
      output.write("\n--- Porta Model Selection ---\n");
      output.write("Select a model provider:\n");
      output.write("  1) openai-compatible (e.g. llama-server on port 8080)\n");
      output.write("  2) ollama\n");
      output.write("  3) openai-codex\n");

      const providerAns = await ask("Choice [1-3] (default 1): ");
      let provider: "ollama" | "openai-compatible" | "openai-codex" = "openai-compatible";
      const choice = providerAns.trim();
      if (choice === "2" || choice.toLowerCase() === "ollama") {
        provider = "ollama";
      } else if (choice === "3" || choice.toLowerCase() === "openai-codex") {
        provider = "openai-codex";
      } else {
        provider = "openai-compatible";
      }

      if (provider === "openai-codex") {
        const models = await fetchAvailableModels("openai-codex");
        let selectedModel = currentConfig.model.model || "gpt-4o";
        if (models.length > 0) {
          output.write("\nAvailable Codex models:\n");
          models.forEach((m, idx) => output.write(`  ${idx + 1}) ${m}\n`));
          const modelAns = await ask(`Select model [1-${models.length}] (default 1): `);
          const num = parseInt(modelAns.trim(), 10);
          if (!isNaN(num) && num >= 1 && num <= models.length) {
            selectedModel = models[num - 1]!;
          } else if (modelAns.trim()) {
            selectedModel = modelAns.trim();
          } else {
            selectedModel = models[0]!;
          }
        } else {
          const modelAns = await ask(`Enter model name (default '${selectedModel}'): `);
          if (modelAns.trim()) selectedModel = modelAns.trim();
        }
        output.write("\n");
        return {
          provider: "openai-codex",
          model: selectedModel,
          timeoutMs: currentConfig.model.timeoutMs ?? 120000,
          maxResponseBytes: (currentConfig.model as Record<string, unknown>).maxResponseBytes as number ?? 8 * 1024 * 1024,
        };
      }

      const defaultBaseUrl = provider === "openai-compatible"
        ? ((currentConfig.model as Record<string, unknown>).baseUrl as string || "http://127.0.0.1:8080")
        : ((currentConfig.model as Record<string, unknown>).baseUrl as string || "http://localhost:11434");

      const urlAns = await ask(`Enter base URL (default '${defaultBaseUrl}'): `);
      const baseUrl = urlAns.trim() || defaultBaseUrl;

      output.write(`Fetching models from ${baseUrl}...\n`);
      const fetchedModels = await fetchAvailableModels(provider, baseUrl);

      let selectedModel = currentConfig.model.model || (provider === "openai-compatible" ? "default" : "llama3");

      if (fetchedModels.length > 0) {
        output.write(`Available models from ${baseUrl}:\n`);
        fetchedModels.forEach((m, idx) => output.write(`  ${idx + 1}) ${m}\n`));
        const modelAns = await ask(`Select model [1-${fetchedModels.length}] (default 1): `);
        const num = parseInt(modelAns.trim(), 10);
        if (!isNaN(num) && num >= 1 && num <= fetchedModels.length) {
          selectedModel = fetchedModels[num - 1]!;
        } else if (modelAns.trim()) {
          selectedModel = modelAns.trim();
        } else {
          selectedModel = fetchedModels[0]!;
        }
      } else {
        output.write("No models could be auto-fetched from server.\n");
        const modelAns = await ask(`Enter model name (default '${selectedModel}'): `);
        if (modelAns.trim()) selectedModel = modelAns.trim();
      }

      const apiKey = "apiKey" in currentConfig.model ? currentConfig.model.apiKey : undefined;
      output.write(`Selected model: ${selectedModel}\n\n`);

      if (provider === "openai-compatible") {
        return {
          provider: "openai-compatible",
          baseUrl,
          model: selectedModel,
          ...(currentConfig.model.timeoutMs ? { timeoutMs: currentConfig.model.timeoutMs } : {}),
          ...(apiKey ? { apiKey } : {}),
        };
      } else {
        return {
          provider: "ollama",
          baseUrl,
          model: selectedModel,
          ...(currentConfig.model.timeoutMs ? { timeoutMs: currentConfig.model.timeoutMs } : {}),
          ...(apiKey ? { apiKey } : {}),
        };
      }
    } finally {
      rl.close();
    }
  }
}
