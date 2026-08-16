import { readFile } from "node:fs/promises";
import { z } from "zod";
import { mcpStdioConfigSchema } from "./adapters/tool-mcp.js";

const toolConfigSchema = z.object({ provider: z.literal("mcp"), id: z.string().min(1), transport: mcpStdioConfigSchema.omit({ providerId: true }) });
export const portaConfigSchema = z.object({
  model: z.object({ provider: z.enum(["ollama", "openai-compatible"]).default("ollama"), baseUrl: z.string().url(), model: z.string().min(1), timeoutMs: z.number().int().positive().optional(), apiKey: z.string().min(1).optional() }),
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
  let file: Record<string, unknown> = {};
  if (path) file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const model = (file.model ?? {}) as Record<string, unknown>;
  const provider = model.provider === "openai-compatible" ? "openai-compatible" : model.provider === "ollama" ? "ollama" : process.env.PORTA_MODEL_PROVIDER === "openai-compatible" ? "openai-compatible" : "ollama";
  const baseUrl = model.baseUrl ?? (provider === "ollama" ? process.env.OLLAMA_BASE_URL : process.env.PORTA_MODEL_BASE_URL) ?? (provider === "ollama" ? "http://localhost:11434" : "http://127.0.0.1:8080");
  const modelName = model.model ?? (provider === "ollama" ? process.env.OLLAMA_MODEL : process.env.PORTA_MODEL);
  const value = {
    ...file,
    model: { provider, baseUrl, model: modelName, ...(model.timeoutMs !== undefined ? { timeoutMs: model.timeoutMs } : {}), ...(model.apiKey !== undefined ? { apiKey: model.apiKey } : {}) },
  };
  return parsePortaConfig(value);
}

/** @deprecated Use loadPortaConfig. */
export const loadHarnessConfig = loadPortaConfig;

export function formatConfigError(error: unknown): string { return error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ") : "Unable to load Porta configuration."; }
