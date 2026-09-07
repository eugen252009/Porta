import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICodexModelProvider } from "../src/adapters/model-openai-codex.js";
import { loadPortaConfig } from "../src/porta-config.js";
import { createPortaApplication } from "../src/porta-application.js";
import { TerminalInputAdapter, TerminalRenderer, runTerminal } from "../src/terminal.js";
import type { ModelRequest } from "../src/contracts.js";

const roots: string[] = [];
async function workspace() { const root = await mkdtemp(join(tmpdir(), "porta-codex-tools-")); roots.push(root); return root; }
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const auth = { getAccess: async () => ({ access: "DO_NOT_LOG_ACCESS", accountId: "DO_NOT_LOG_ACCOUNT" }) };
const defaultTools = ["artifact/list", "artifact/read", "artifact/search", "artifact/stat", "scratchpad/append", "scratchpad/list", "scratchpad/read", "scratchpad/search", "scratchpad/write", "task/create", "task/get", "task/update"];
interface WireTool { type: string; name: string; description: string; parameters: unknown; strict: boolean }
interface WireItem { type?: string; name?: string; call_id?: string; arguments?: string; output?: string }
interface WireRequest { tools: WireTool[]; input: WireItem[] }
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const done = (output: unknown[] = []) => ({ type: "response.completed", response: { status: "completed", output } });
const final = (text: string) => sse({ type: "response.output_text.delta", delta: text }, done());
function call(tool: WireTool | undefined, input: unknown, id: string): Response {
  if (!tool) throw new Error("Expected tool was not advertised in the HTTP request");
  const item = { type: "function_call", name: tool.name, call_id: id, arguments: JSON.stringify(input) };
  // Captured real Codex event shape: the final success event need not repeat the call.
  return sse({ type: "response.output_item.added", item: { ...item, arguments: "" } }, { type: "response.function_call_arguments.delta", delta: item.arguments }, { type: "response.output_item.done", item }, done([]));
}
async function cliConfig(root?: string, mutation = false, execution = false) {
  vi.stubEnv("PORTA_CONFIG", ""); vi.stubEnv("HARNESS_CONFIG", "");
  vi.stubEnv("PORTA_MODEL_PROVIDER", "openai-codex"); vi.stubEnv("PORTA_MODEL", "gpt-5.6-sol");
  if (root) {
    const path = join(root, "porta.json");
    await writeFile(path, JSON.stringify({ filesystem: { root, mutation: { enabled: mutation } }, ...(execution ? { execution: { enabled: true, allowedCommands: ["node"], sandbox: { preference: ["sandbox.host-process"] } } } : {}) }));
    vi.stubEnv("PORTA_CONFIG", path);
  }
  return loadPortaConfig();
}

/** Checks the actual HTTP body, not just mapRequestToCodex or injected incoming calls. */
function expectDefinitions(body: WireRequest, request: ModelRequest) {
  expect(body.tools).toEqual(request.tools!.map((tool, index) => ({ type: "function", name: `harness_tool_${index}`, description: tool.description ?? tool.name, parameters: tool.inputSchema, strict: false })));
  expect(new Set(body.tools.map((tool) => tool.name)).size).toBe(body.tools.length);
  for (const tool of body.tools) {
    expect(tool).not.toHaveProperty("function"); // Responses API, not Chat Completions nesting.
    expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(tool.parameters).toMatchObject({ type: "object" });
  }
}

describe("CLI → agent → Codex outgoing tools", () => {
  it.each(["default", "read-only", "writable", "execution"])("exposes exactly the %s CLI composition to the agent and HTTP request", async (mode) => {
    const root = mode === "default" ? undefined : await workspace();
    const config = await cliConfig(root, mode === "writable", mode === "execution");
    const requests: ModelRequest[] = []; const bodies: WireRequest[] = [];
    const app = await createPortaApplication(config, { model: (modelConfig) => {
      const provider = new OpenAICodexModelProvider(modelConfig, auth, async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as WireRequest); return final("ready"); });
      return { descriptor: provider.descriptor, generate(request, context) { requests.push(request); return provider.generate(request, context); } };
    } });
    try {
      const expected = [...defaultTools, ...(root ? ["filesystem/list_directory", "filesystem/read_file", "filesystem/search", "filesystem/stat"] : []), ...(mode === "writable" ? ["filesystem/patch_file", "filesystem/write_file"] : []), ...(mode === "execution" ? ["execution/run"] : [])].sort();
      expect(app.toolRouter.listTools().map((tool) => tool.canonicalId)).toEqual(expected);
      let sessionId = "";
      for await (const event of app.gateway.execute({ type: "CreateSession" })) if (event.type === "SessionCreated") sessionId = event.sessionId;
      for await (const _event of app.gateway.execute({ type: "SubmitInput", sessionId, input: "hello" })) { /* normal CLI gateway path */ }
      expect(requests).toHaveLength(1); expect(bodies).toHaveLength(1);
      expect(requests[0]!.tools!.map((tool) => tool.id)).toEqual(expected);
      expectDefinitions(bodies[0]!, requests[0]!);
      if (mode === "writable") {
        for (const id of ["filesystem/read_file", "filesystem/write_file"]) {
          const index = requests[0]!.tools!.findIndex((tool) => tool.id === id);
          expect(bodies[0]!.tools[index]).toMatchObject({ type: "function", parameters: { required: expect.arrayContaining(["path"]) } });
        }
      }
    } finally { await app.shutdown(); }
  });

  it("creates and reads a real file through approved terminal tool calls and returns the read result to Codex", async () => {
    const root = await workspace(); const config = await cliConfig(root, true);
    const requests: ModelRequest[] = []; const bodies: WireRequest[] = [];
    const app = await createPortaApplication(config, { model: (modelConfig) => {
      const provider = new OpenAICodexModelProvider(modelConfig, auth, async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as WireRequest; bodies.push(body);
        if (bodies.length === 1) return call(body.tools.find((tool) => tool.description.startsWith("Create or replace an entire")), { path: "porta-live.txt", content: "PORTA_TOOL_OK", mode: "create" }, "write-call");
        if (bodies.length === 2) return call(body.tools.find((tool) => tool.description.startsWith("Read a text file")), { path: "porta-live.txt", mode: "exact" }, "read-call");
        if (bodies.length !== 3) throw new Error("Unexpected model turn");
        const result = body.input.filter((item) => item.type === "function_call_output").at(-1);
        return final((JSON.parse(result!.output!) as { content: string }).content);
      });
      return { descriptor: provider.descriptor, generate(request, context) { requests.push(request); return provider.generate(request, context); } };
    } });
    const inputStream = new PassThrough(); const input = new TerminalInputAdapter(inputStream);
    let output = ""; const sink = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } });
    const renderer = new TerminalRenderer(sink);
    try {
      await app.start(); renderer.renderStartup(config.model.model, app.toolRouter.listTools().map((tool) => tool.canonicalId));
      const terminal = runTerminal(app.gateway, input, renderer, sink);
      inputStream.end("Create a file named porta-live.txt containing PORTA_TOOL_OK. Read the file back and reply only with its contents.\ny\ny\n");
      await terminal;
      expect(await readFile(join(root, "porta-live.txt"), "utf8")).toBe("PORTA_TOOL_OK");
      expect(bodies).toHaveLength(3);
      for (let index = 0; index < bodies.length; index++) expectDefinitions(bodies[index]!, requests[index]!);
      const writeResult = bodies[1]!.input.find((item) => item.type === "function_call_output")!;
      expect(JSON.parse(writeResult.output!)).toMatchObject({ path: "porta-live.txt" });
      const readResult = bodies[2]!.input.filter((item) => item.type === "function_call_output").at(-1)!;
      expect(JSON.parse(readResult.output!)).toMatchObject({ content: "PORTA_TOOL_OK", mode: "exact" });
      for (const body of bodies.slice(1)) {
        for (const item of body.input.filter((entry) => entry.type === "function_call_output")) {
          expect(body.input.filter((entry) => entry.type === "function_call" && entry.call_id === item.call_id)).toHaveLength(1);
        }
      }
      expect(output).toContain("Tools: 18"); expect(output).toContain("Filesystem: read/write");
      expect(output).toContain("[tool completed] filesystem/write_file"); expect(output).toContain("[tool completed] filesystem/read_file");
      expect(output.match(/\[approval\] approve/g)).toHaveLength(2);
      expect(output).toContain("PORTA_TOOL_OK\n\nAssistant complete.");
      expect(output).not.toContain("DO_NOT_LOG");
    } finally { input.close(); await app.shutdown(); }
  });
});
