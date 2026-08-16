import { mkdirSync, writeFileSync } from "node:fs";
import { loadPortaConfig } from "../../src/porta-config.js";
import { OllamaModelProvider } from "../../src/adapters/model-ollama.js";
import { OpenAICompatibleModelProvider } from "../../src/adapters/model-openai-compatible.js";
import { LiveQualificationRunner, markdownSummary, QualificationBudget } from "./live-runner.js";

const reportDirectory = process.env.PORTA_QUALIFICATION_REPORT_DIR ?? ".tmp/porta-qualification";
function positiveInt(name: string): number | undefined { const raw = process.env[name]; if (raw === undefined) return undefined; const value = Number(raw); return Number.isInteger(value) && value > 0 ? value : undefined; }
const budget: Partial<QualificationBudget> = { maxTurns: positiveInt("PORTA_QUALIFICATION_MAX_TURNS"), maxToolCalls: positiveInt("PORTA_QUALIFICATION_MAX_TOOL_CALLS"), maxExecutions: positiveInt("PORTA_QUALIFICATION_MAX_EXECUTIONS"), maxMutations: positiveInt("PORTA_QUALIFICATION_MAX_MUTATIONS"), maxDurationMs: positiveInt("PORTA_QUALIFICATION_MAX_DURATION_MS") };
try {
  const config = await loadPortaConfig();
  const runner = new LiveQualificationRunner({ baseConfig: config, budget, reportDirectory, model: (modelConfig) => modelConfig.provider === "openai-compatible" ? new OpenAICompatibleModelProvider(modelConfig) : new OllamaModelProvider(modelConfig) });
  const results = await runner.runAll();
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(`${reportDirectory}/summary.json`, `${JSON.stringify(results, null, 2)}\n`);
  console.log(markdownSummary(results));
  console.log(`JSON reports: ${reportDirectory}`);
  process.exitCode = results.every((result) => result.outcome === "success") ? 0 : 1;
} catch (error) {
  console.error(`Live qualification could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
