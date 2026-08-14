import { readFile } from "node:fs/promises";
import { z } from "zod";
import { mcpStdioConfigSchema } from "./adapters/tool-mcp.js";

const toolConfigSchema = z.object({ provider: z.literal("mcp"), id: z.string().min(1), transport: mcpStdioConfigSchema.omit({ providerId: true }) });
export const harnessConfigSchema = z.object({
  model: z.object({ provider: z.literal("ollama"), baseUrl: z.string().url(), model: z.string().min(1), timeoutMs: z.number().int().positive().optional() }),
  tools: z.array(toolConfigSchema).default([]),
  authorization: z.object({ mode: z.enum(["allow-all", "require-approval"]) }).default({ mode: "require-approval" }),
  agent: z.object({ maxSteps: z.number().int().positive().optional(), maxToolCalls: z.number().int().positive().optional() }).default({}),
});
export type HarnessConfig = z.infer<typeof harnessConfigSchema>;

export function parseHarnessConfig(value: unknown): HarnessConfig { return harnessConfigSchema.parse(value); }

export async function loadHarnessConfig(path = process.env.HARNESS_CONFIG): Promise<HarnessConfig> {
  let file: Record<string, unknown> = {};
  if (path) file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const model = (file.model ?? {}) as Record<string, unknown>;
  const value = {
    ...file,
    model: { provider: "ollama", baseUrl: model.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434", model: model.model ?? process.env.OLLAMA_MODEL, ...(model.timeoutMs !== undefined ? { timeoutMs: model.timeoutMs } : {}) },
  };
  return parseHarnessConfig(value);
}

export function formatConfigError(error: unknown): string { return error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ") : "Unable to load harness configuration."; }
