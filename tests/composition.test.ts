import { describe, expect, it } from "vitest";
import { compose, OllamaModelProvider } from "../src/index.js";

describe("model replacement composition", () => {
  it("uses the same kernel composition with an Ollama provider", () => {
    const provider = new OllamaModelProvider({ baseUrl: "http://provider.test", model: "generic-model" }, async () => new Response());
    const harness = compose(provider);
    expect(harness.kernel).toBeDefined();
  });
});
