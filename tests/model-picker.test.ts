import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ModelPicker } from "../src/model-picker.js";
import { parsePortaConfig } from "../src/porta-config.js";

describe("ModelPicker", () => {
  it("interactively selects provider and model options", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += String(chunk); });

    const baseConfig = parsePortaConfig({ model: { provider: "ollama", baseUrl: "http://localhost:11434", model: "initial" } });

    const promise = ModelPicker.promptInteractive(baseConfig, { input, output });
    setTimeout(() => {
      input.write("1\nhttp://localhost:8080\nmy-custom-model\n");
    }, 10);

    const selected = await promise;
    expect(selected).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8080",
      model: "my-custom-model",
    });
    expect(text).toContain("--- Porta Model Selection ---");
    expect(text).toContain("Select a model provider:");
  });

  it("selects provider by preferred key or throws if unavailable", async () => {
    const fakeModel = { descriptor: { id: "fake", version: "1", capabilities: [] }, generate: async function* () {} };
    const picker = new ModelPicker({ ollama: fakeModel });

    await expect(picker.selectProvider("ollama")).resolves.toBe(fakeModel);
    await expect(new ModelPicker({}).selectProvider()).rejects.toThrow();
  });
});
