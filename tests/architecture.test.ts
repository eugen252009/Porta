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
    for (const file of sourceFiles.filter((file) => !file.includes("model-ollama") && !file.includes("porta-application") && !file.includes("porta-config") && !file.endsWith("src/index.ts"))) expect(readFileSync(file, "utf8")).not.toMatch(/ollama/i);
  });
  it("keeps runtime and sandbox ports free of concrete adapter imports", () => { for (const file of ["src/contracts.ts", "src/runtime.ts"]) expect(readFileSync(join(process.cwd(), file), "utf8")).not.toMatch(/mock-runtime|mock-sandbox|deno|node-runtime|bun|bubblewrap|container/i); });
  it("keeps Deno knowledge confined to Deno adapter modules", () => { for (const file of files(join(process.cwd(), "src")).filter((file) => !file.includes("runtime-deno") && !file.includes("sandbox-deno-permissions") && !file.endsWith("src/index.ts"))) expect(readFileSync(file, "utf8")).not.toMatch(/deno|deno\.permissions/i); });
  it("keeps tool router and contracts protocol-neutral", () => { for (const file of ["src/contracts.ts", "src/tools.ts", "src/tool-mocks.ts"]) expect(readFileSync(join(process.cwd(), file), "utf8")).not.toMatch(/mcp|json-rpc|openai|anthropic/i); });
  it("keeps MCP imports confined to the adapter", () => { for (const file of files(join(process.cwd(), "src")).filter((file) => !file.includes("tool-mcp") && !file.includes("porta-application") && !file.includes("porta-config") && !file.endsWith("src/index.ts"))) expect(readFileSync(file, "utf8")).not.toMatch(/modelcontextprotocol|MCP/i); });
  it("keeps agent orchestration provider-neutral", () => { for (const file of ["src/agent.ts", "src/agent-mocks.ts"]) expect(readFileSync(join(process.cwd(), file), "utf8")).not.toMatch(/ollama|mcp|deno|openai|anthropic/i); });
  it("keeps interactive approval generic", () => { for (const file of ["src/application-gateway.ts", "src/approval-pending.ts"]) expect(readFileSync(join(process.cwd(), file), "utf8")).not.toMatch(/ollama|mcp|deno|react|browser|tui|http|websocket/i); expect(readFileSync(join(process.cwd(), "src/agent.ts"), "utf8")).not.toMatch(/application-gateway|ApplicationGateway/); });
  it("keeps conversation ownership provider-neutral", () => { expect(readFileSync(join(process.cwd(), "src/conversation.ts"), "utf8")).not.toMatch(/ollama|mcp|terminal|modelcontextprotocol/i); expect(readFileSync(join(process.cwd(), "src/agent.ts"), "utf8")).not.toMatch(/ConversationStore|MemoryConversationStore|porta-application/); expect(readFileSync(join(process.cwd(), "src/tools.ts"), "utf8")).not.toMatch(/ConversationSession|ConversationStore/); });
  it("keeps filesystem and scratchpad adapters generic", () => { for (const file of ["src/filesystem.ts", "src/scratchpad.ts", "src/content-reducer.ts"]) expect(readFileSync(join(process.cwd(), file), "utf8")).not.toMatch(/ollama|mcp|deno|modelcontextprotocol/i); });
  it("keeps compaction independent from scratchpad and filesystem mutation", () => { const source = readFileSync(join(process.cwd(), "src/compaction.ts"), "utf8"); expect(source).not.toMatch(/ScratchpadStore|FilesystemToolProvider|write|append|delete/i); });
  it("keeps search engines source-neutral", () => { const source = readFileSync(join(process.cwd(), "src/search.ts"), "utf8"); expect(source).not.toMatch(/ScratchpadStore|ConversationStore|FilesystemToolProvider|OllamaModelProvider|MCPToolProvider/i); });
});
