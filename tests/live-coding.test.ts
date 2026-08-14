import { describe, expect, it } from "vitest";
import { loadPortaConfig } from "../src/porta-config.js";
import { OllamaModelProvider } from "../src/adapters/model-ollama.js";
import { LiveQualificationRunner } from "./qualification/live-runner.js";

const live = process.env.RUN_PORTA_LIVE_QUALIFICATION === "1" ? describe : describe.skip;

live("Porta real model live coding qualification", () => {
  it("drives fresh local fixtures through normal Porta composition", async () => {
    const config = await loadPortaConfig();
    const results = await new LiveQualificationRunner({ baseConfig: config, model: (modelConfig) => new OllamaModelProvider(modelConfig) }).runAll();
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.every((result) => result.outcome === "success"), JSON.stringify(results, null, 2)).toBe(true);
  }, 15 * 60 * 1000);
});
