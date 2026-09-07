import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { mcpStdioConfigSchema } from "./adapters/tool-mcp.js";

const toolConfigSchema = z.object({ provider: z.literal("mcp"), id: z.string().min(1), transport: mcpStdioConfigSchema.omit({ providerId: true }) });

const ollamaModelConfigSchema = z.object({
  provider: z.literal("ollama").default("ollama"),
  baseUrl: z.string().url(),
  model: z.string().min(1).default("llama3"),
  timeoutMs: z.number().int().positive().optional(),
  apiKey: z.string().min(1).optional(),
});

const openAICompatibleModelConfigSchema = z.object({
  provider: z.literal("openai-compatible"),
  baseUrl: z.string().url(),
  model: z.string().min(1).default("default"),
  timeoutMs: z.number().int().positive().optional(),
  apiKey: z.string().min(1).optional(),
});

const openAICodexModelConfigSchema = z.object({
  provider: z.literal("openai-codex"),
  model: z.string().min(1).default("gpt-4o"),
  timeoutMs: z.number().int().positive().max(2147483647).default(120000),
  maxResponseBytes: z.number().int().positive().max(64 * 1024 * 1024).default(8 * 1024 * 1024),
}).strict();

const modelConfigSchema = z.preprocess(
  (val: unknown) => {
    if (val && typeof val === "object" && !("provider" in val)) {
      return { provider: "ollama", ...val };
    }
    return val;
  },
  z.discriminatedUnion("provider", [
    ollamaModelConfigSchema,
    openAICompatibleModelConfigSchema,
    openAICodexModelConfigSchema,
  ])
);

export const portaConfigSchema = z.object({
  model: modelConfigSchema,
  tools: z.array(toolConfigSchema).default([]),
  authorization: z.object({ mode: z.enum(["allow-all", "require-approval"]) }).default({ mode: "require-approval" }),
  agent: z.object({ maxSteps: z.number().int().positive().optional(), maxToolCalls: z.number().int().positive().optional() }).default({}),
  conversation: z.object({ maxTurns: z.number().int().positive().optional(), compaction: z.object({ enabled: z.boolean().default(false), keepRecentTurns: z.number().int().positive().default(4), maxManifestEntries: z.number().int().positive().default(20) }).optional() }).default({}),
  filesystem: z.object({ root: z.string().min(1), maxExactContextBytes: z.number().int().positive().optional(), maxReadBytes: z.number().int().positive().optional(), maxSummaryChars: z.number().int().positive().optional(), mutation: z.object({ enabled: z.boolean().default(false), maxWriteBytes: z.number().int().positive().optional(), maxPatchTargetBytes: z.number().int().positive().optional() }).optional() }).optional(),
  execution: z.object({ enabled: z.boolean().default(false), allowedCommands: z.array(z.string().min(1)).default([]), defaultTimeoutMs: z.number().int().positive().default(120000), maxStdoutBytes: z.number().int().positive().default(262144), maxStderrBytes: z.number().int().positive().default(262144), filesystem: z.enum(["allow", "deny", "best-effort"]).default("best-effort"), network: z.enum(["allow", "deny", "best-effort"]).default("best-effort"), codeLoading: z.enum(["allow", "deny", "best-effort"]).default("best-effort"), environment: z.record(z.string()).default({}), allowedEnvironmentKeys: z.array(z.string()).default(["PATH"]), sandbox: z.object({ preference: z.array(z.string().min(1)).default(["sandbox.linux-bubblewrap", "sandbox.host-process"]) }).default({}) }).optional(),
  git: z.object({ enabled: z.boolean().default(false), executable: z.string().min(1).optional(), maxStatusEntries: z.number().int().positive().default(1000), maxDiffBytes: z.number().int().positive().default(262144), maxShowBytes: z.number().int().positive().default(262144), maxLogEntries: z.number().int().positive().max(100).default(20) }).optional(),
  persistence: z.object({ enabled: z.boolean().default(false), driver: z.literal("sqlite").default("sqlite"), path: z.string().min(1).default(".porta/porta.db"), maxArtifactBytes: z.number().int().positive().default(64 * 1024 * 1024), maxArtifactContextBytes: z.number().int().positive().default(64 * 1024) }).optional(),
});
export type PortaConfig = z.infer<typeof portaConfigSchema>;
/** @deprecated Use PortaConfig. */
export type HarnessConfig = PortaConfig;
/** @deprecated Use portaConfigSchema. */
export const harnessConfigSchema = portaConfigSchema;

export function parsePortaConfig(value: unknown): PortaConfig { return portaConfigSchema.parse(value); }
/** @deprecated Use parsePortaConfig. */
export const parseHarnessConfig = parsePortaConfig;

export async function loadPortaConfig(path = process.env.PORTA_CONFIG ?? process.env.HARNESS_CONFIG): Promise<PortaConfig> {
  let targetPath = path;
  if (targetPath === undefined) {
    if (existsSync("porta.json")) targetPath = "porta.json";
    else if (existsSync(".porta/config.json")) targetPath = ".porta/config.json";
  }
  let file: Record<string, unknown> = {};
  if (targetPath) file = JSON.parse(await readFile(targetPath, "utf8")) as Record<string, unknown>;
  const model = (file.model ?? {}) as Record<string, unknown>;
  const provider = model.provider ?? process.env.PORTA_MODEL_PROVIDER ?? "ollama";
  const defaultModelName = provider === "ollama" ? "llama3" : provider === "openai-codex" ? "gpt-4o" : "default";

  let modelObj: Record<string, unknown>;
  if (provider === "openai-codex") {
    const modelName = model.model ?? process.env.PORTA_MODEL ?? defaultModelName;
    modelObj = {
      provider: "openai-codex",
      model: modelName,
      ...(model.timeoutMs !== undefined ? { timeoutMs: model.timeoutMs } : {}),
      ...(model.maxResponseBytes !== undefined ? { maxResponseBytes: model.maxResponseBytes } : {}),
      ...(model.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
      ...(model.apiKey !== undefined ? { apiKey: model.apiKey } : {}),
    };
  } else {
    const baseUrl = model.baseUrl ?? (provider === "ollama" ? process.env.OLLAMA_BASE_URL : process.env.PORTA_MODEL_BASE_URL) ?? (provider === "ollama" ? "http://localhost:11434" : "http://127.0.0.1:8080");
    const modelName = model.model ?? (provider === "ollama" ? process.env.OLLAMA_MODEL : process.env.PORTA_MODEL) ?? defaultModelName;
    modelObj = {
      provider,
      baseUrl,
      model: modelName,
      ...(model.timeoutMs !== undefined ? { timeoutMs: model.timeoutMs } : {}),
      ...(model.apiKey !== undefined ? { apiKey: model.apiKey } : {}),
    };
  }

  const value = {
    ...file,
    model: modelObj,
  };
  return parsePortaConfig(value);
}

export async function savePortaConfig(config: PortaConfig, path = process.env.PORTA_CONFIG ?? process.env.HARNESS_CONFIG ?? "porta.json"): Promise<void> {
  const targetPath = path || "porta.json";
  const dir = dirname(targetPath);
  if (dir && dir !== ".") await mkdir(dir, { recursive: true });
  await writeFile(targetPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** @deprecated Use loadPortaConfig. */
export const loadHarnessConfig = loadPortaConfig;

export function formatConfigError(error: unknown): string { return error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ") : "Unable to load Porta configuration."; }
