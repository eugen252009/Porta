import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { InputAdapter, InputMessage, JsonValue, KernelEvent, PresentationEvent, Renderer, ApplicationGateway } from "./contracts.js";

export class TerminalInputAdapter implements InputAdapter {
  private readonly linesIterator: AsyncIterator<string>;
  private readonly readline;
  constructor(input: Readable) { this.readline = createInterface({ input, terminal: false }); this.linesIterator = this.readline[Symbol.asyncIterator](); }
  close(): void { this.readline.close(); }
  async nextLine(): Promise<string | undefined> { const result = await this.linesIterator.next(); return result.done ? undefined : result.value; }
  async *input(): AsyncIterable<InputMessage> { for (;;) { const line = await this.nextLine(); if (line === undefined) return; yield { schemaVersion: 1, type: "submit-input", input: line }; } }
}

export class TerminalRenderer implements Renderer {
  constructor(private readonly output: Writable) {}
  async render(presentation: PresentationEvent): Promise<void> { this.renderEvent(presentation.event); }
  renderEvent(event: KernelEvent): void {
    if (event.type === "OutputDelta") this.output.write(event.text);
    else if (event.type === "OutputStarted") this.output.write("\nThinking...\n");
    else if (event.type === "ToolRequested") this.output.write(`\n[tool requested] ${event.toolId}\n`);
    else if (event.type === "ToolStarted") this.output.write(`[tool started] ${event.toolId}\n`);
    else if (event.type === "ToolCompleted") this.output.write(`[tool completed] ${event.toolId}\n`);
    else if (event.type === "ApprovalRequested") this.output.write(`\nApproval required\nTool: ${event.toolId}\nInput: ${JSON.stringify(event.input, null, 2)}\nApprove? [y/N] `);
    else if (event.type === "ApprovalResolved") this.output.write(`[approval] ${event.decision}\n`);
    else if (event.type === "ExecutionCompleted") this.output.write("\n\nAssistant complete.\n");
    else if (event.type === "ExecutionCancelled") this.output.write("\n[cancelled]\n");
    else if (event.type === "Error") this.output.write(`\n[error] ${event.error.message}\n`);
  }
  write(text: string): void { this.output.write(text); }
  renderStartup(model: string, tools: readonly string[]): void {
    const maxDisplayedTools = 64;
    const displayedTools = tools.slice(0, maxDisplayedTools).map((tool) => {
      const truncated = tool.length > 80 ? tool.slice(0, 80) + "..." : tool;
      return JSON.stringify(truncated);
    });
    const extraCount = tools.length > maxDisplayedTools ? tools.length - maxDisplayedTools : 0;
    const toolsSummary = displayedTools.join(", ") + (extraCount > 0 ? `, ... ${extraCount} more tools` : "");
    const escapedModel = JSON.stringify(model);

    const hasFilesystemWrite = tools.some((t) => t.startsWith("filesystem/write") || t.startsWith("filesystem/patch"));
    const hasFilesystemRead = tools.some((t) => t.startsWith("filesystem/"));
    let fsStatus = "disabled";
    if (hasFilesystemWrite) {
      fsStatus = "read/write";
    } else if (hasFilesystemRead) {
      fsStatus = "read-only";
    }

    const hasExecution = tools.some((t) => t.startsWith("execution/"));
    let execStatus = "disabled";
    if (hasExecution) {
      execStatus = "enabled (subject to allowlist, approvals, and sandbox policy)";
    }

    let message = `Model: ${escapedModel}\nTools: ${tools.length}\n[${toolsSummary}]\nFilesystem: ${fsStatus}\n`;
    if (fsStatus === "disabled") {
      message += "To enable file creation and modification, configure filesystem.root and filesystem.mutation.enabled in PORTA_CONFIG.\n";
    }
    message += `Command execution: ${execStatus}\n\n`;

    this.output.write(message);
  }
}

export async function runTerminal(gateway: ApplicationGateway, input: TerminalInputAdapter, renderer: TerminalRenderer, output: Writable, resumeSessionId?: string): Promise<void> {
  const created = await collect(gateway, { type: "CreateSession", ...(resumeSessionId ? { sessionId: resumeSessionId } : {}) }, {});
  const sessionId = created.find((event): event is Extract<KernelEvent, { type: "SessionCreated" }> => event.type === "SessionCreated")?.sessionId;
  if (!sessionId) { const error = created.find((event) => event.type === "Error"); throw new Error(error?.type === "Error" ? error.error.message : "Could not create terminal session."); }
  output.write("Porta ready.\n\n> ");
  let stopping = false;
  const cancel = async () => { if (!stopping) { stopping = true; await collect(gateway, { type: "CancelExecution", sessionId }, {}); } };
  const onSignal = () => { input.close(); void cancel(); };
  process.once("SIGINT", onSignal);
  try {
    while (!stopping) {
      const line = await input.nextLine();
      if (line === undefined) break;
      if (line.trim() === "/cancel") { await collect(gateway, { type: "CancelExecution", sessionId }, {}); output.write("\n> "); continue; }
      if (!line.trim()) { output.write("> "); continue; }
      const execution = gateway.execute({ type: "SubmitInput", sessionId, input: line }, {});
      for await (const event of execution) {
        renderer.renderEvent(event);
        if (event.type === "ApprovalRequested") {
          const answer = await input.nextLine();
          const decision = answer?.trim().toLowerCase() === "y" || answer?.trim().toLowerCase() === "yes" ? "approve" : "deny";
          for await (const _approvalEvent of gateway.execute({ type: "ResolveApproval", approvalId: event.approvalId, decision }, {})) { /* execution stream renders the canonical resolution event */ }
        }
      }
      if (!stopping) output.write("\n> ");
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    await collect(gateway, { type: "CloseSession", sessionId }, {});
  }
}

async function collect(gateway: ApplicationGateway, command: Parameters<ApplicationGateway["execute"]>[0], context: Parameters<ApplicationGateway["execute"]>[1]): Promise<KernelEvent[]> { const events: KernelEvent[] = []; for await (const event of gateway.execute(command, context)) events.push(event); return events; }
export function json(value: JsonValue): string { return JSON.stringify(value, null, 2); }
