import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { TerminalRenderer } from "../src/terminal.js";

function startup(tools: readonly string[], model = "test-model") {
  let output = "";
  const sink = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } });
  new TerminalRenderer(sink).renderStartup(model, tools);
  return output;
}

describe("terminal startup capabilities", () => {
  it("makes absent filesystem and execution tools visible without implying a runtime or sandbox", () => {
    const output = startup(["scratchpad/write", "task/get"]);
    expect(output).toContain("Tools: 2"); expect(output).toContain('"scratchpad/write"');
    expect(output).toContain("Filesystem: disabled"); expect(output).toContain("Command execution: disabled");
    expect(output).toContain("filesystem.root and filesystem.mutation.enabled in PORTA_CONFIG");
    expect(output).not.toContain("Runtime:"); expect(output).not.toContain("Sandbox:");
  });
  it("distinguishes read-only tools from writes and reports only registered execution", () => {
    expect(startup(["filesystem/read_file"])).toContain("Filesystem: read-only");
    const output = startup(["filesystem/read_file", "filesystem/write_file", "execution/run"]);
    expect(output).toContain("Filesystem: read/write"); expect(output).not.toContain("To enable file creation");
    expect(output).toContain("subject to allowlist, approvals, and sandbox policy");
  });
  it("bounds and escapes untrusted display metadata instead of dumping configuration or schemas", () => {
    const output = startup(Array.from({ length: 70 }, (_, index) => `${index}/${"x".repeat(1000)}\x1b[31m`), "model\n\x1b[31m");
    expect(output).toContain("Tools: 70"); expect(output).toContain("... 6 more tools");
    expect(output).toContain('"model\\n\\u001b[31m"'); expect(output).not.toContain("\x1b");
    expect(output.length).toBeLessThan(12000);
  });
});
