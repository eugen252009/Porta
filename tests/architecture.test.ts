import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []); }
describe("architecture boundaries", () => {
  it("keeps kernel and contracts free of concrete infrastructure imports", () => {
    for (const directory of ["src/kernel.ts", "src/contracts.ts", "src/plugin-preflight.ts", "src/runtime.ts"]) {
      const source = readFileSync(join(process.cwd(), directory), "utf8");
      expect(source).not.toMatch(/from\s+["'](?:[^"']*vendor|[^"']*protocol|[^"']*database|[^"']*mcp|[^"']*express|[^"']*react|[^"']*sqlite|[^"']*postgres)/i);
    }
    expect(files(join(process.cwd(), "src")).filter((file) => file.includes("kernel") || file.includes("contracts")).length).toBeGreaterThan(0);
  });
  it("keeps Ollama imports confined to its adapter", () => {
    const sourceFiles = files(join(process.cwd(), "src"));
    for (const file of sourceFiles.filter((file) => !file.includes("model-ollama") && !file.endsWith("src/index.ts"))) expect(readFileSync(file, "utf8")).not.toMatch(/ollama/i);
  });
  it("keeps runtime and sandbox ports free of concrete adapter imports", () => { for (const file of ["src/contracts.ts", "src/runtime.ts"]) expect(readFileSync(join(process.cwd(), file), "utf8")).not.toMatch(/mock-runtime|mock-sandbox|deno|node-runtime|bun|bubblewrap|container/i); });
  it("keeps Deno knowledge confined to Deno adapter modules", () => { for (const file of files(join(process.cwd(), "src")).filter((file) => !file.includes("runtime-deno") && !file.includes("sandbox-deno-permissions") && !file.endsWith("src/index.ts"))) expect(readFileSync(file, "utf8")).not.toMatch(/deno|deno\.permissions/i); });
});
