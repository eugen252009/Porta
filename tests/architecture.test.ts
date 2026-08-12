import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []); }
describe("architecture boundaries", () => {
  it("keeps kernel and contracts free of concrete infrastructure imports", () => {
    for (const directory of ["src/kernel.ts", "src/contracts.ts"]) {
      const source = readFileSync(join(process.cwd(), directory), "utf8");
      expect(source).not.toMatch(/from\s+["'](?:[^"']*vendor|[^"']*protocol|[^"']*database|[^"']*mcp|[^"']*express|[^"']*react|[^"']*sqlite|[^"']*postgres)/i);
    }
    expect(files(join(process.cwd(), "src")).filter((file) => file.includes("kernel") || file.includes("contracts")).length).toBeGreaterThan(0);
  });
});
