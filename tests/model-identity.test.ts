import { describe, expect, it } from "vitest";
import { modelRef, optionMatchesSelection, resolveModelOption, withModelIdentity } from "../src/model-identity.js";

describe("qualified model identity", () => {
  it("resolves provider-qualified OpenAI API model IDs to their canonical connection", () => {
    const codex = withModelIdentity({ id: "gpt-test", displayName: "GPT Test", provider: "openai-codex" }, "openai-subscription-main");
    expect(resolveModelOption([codex], "openai-codex/gpt-test", "ollama")).toBe(codex);
    expect(resolveModelOption([codex], codex.ref!, "ollama")).toBe(codex);
  });

  it("refuses ambiguous provider-qualified IDs when connections expose the same model", () => {
    const first = withModelIdentity({ id: "gemma4", displayName: "Gemma4", provider: "openai-compatible" }, "server-a");
    const second = withModelIdentity({ id: "gemma4", displayName: "Gemma4", provider: "openai-compatible" }, "server-b");
    expect(resolveModelOption([first, second], "openai-compatible/gemma4", "ollama")).toBeUndefined();
    expect(resolveModelOption([first, second], first.ref!, "ollama")).toBe(first);
  });

  it("keeps duplicate display names distinct and routable", () => {
    const ollama = withModelIdentity({ id: "gemma4", displayName: "Gemma4", provider: "ollama" }, "ollama-local", "Ollama");
    const api = withModelIdentity({ id: "gemma4", displayName: "Gemma4", provider: "openai-compatible" }, "nas-api", "OpenAI Compatible");
    expect(ollama.ref).toBe(modelRef("ollama-local", "gemma4"));
    expect(api.ref).toBe(modelRef("nas-api", "gemma4"));
    expect(ollama.ref).not.toBe(api.ref);
    expect(optionMatchesSelection(ollama, { provider: "ollama", model: "gemma4", connectionId: "ollama-local", modelRef: ollama.ref })).toBe(true);
    expect(optionMatchesSelection(ollama, { provider: "openai-compatible", model: "gemma4", connectionId: "nas-api", modelRef: api.ref })).toBe(false);
  });
});
