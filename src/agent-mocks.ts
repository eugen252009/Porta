import { ModelContext, ModelEvent, ModelProvider, ModelRequest, ModelToolResult } from "./contracts.js";

export type ScriptedTurn = { type: "text"; text: string } | { type: "tool"; toolId: string; input: import("./contracts.js").JsonValue; id?: string };
export class ScriptedToolModelProvider implements ModelProvider {
  readonly descriptor = { id: "scripted-tools", version: "1", capabilities: [{ id: "model.tools", version: "1" }] };
  turns = 0; received: ModelRequest[] = [];
  constructor(private readonly scripts: readonly (readonly ScriptedTurn[])[]) {}
  async *generate(request: ModelRequest, context: ModelContext): AsyncIterable<ModelEvent> { this.received.push(request); const script = this.scripts[Math.min(this.turns++, this.scripts.length - 1)] ?? []; for (const turn of script) { if (context.signal.aborted) return; if (turn.type === "text") yield { type: "delta", text: turn.text }; else yield { type: "tool-call", call: { id: turn.id ?? `call-${this.turns}`, toolId: turn.toolId, input: turn.input } }; } yield { type: "completed" }; }
}

export class ResultAwareToolModelProvider implements ModelProvider {
  readonly descriptor = { id: "result-aware", version: "1", capabilities: [{ id: "model.tools", version: "1" }] }; turns = 0;
  async *generate(request: ModelRequest): AsyncIterable<ModelEvent> { if (this.turns++ === 0) yield { type: "tool-call", call: { id: "call-1", toolId: "provider/add", input: { left: 2, right: 3 } } }; else { const result = request.messages?.find((message) => message.role === "tool") as Extract<import("./contracts.js").ModelMessage, { role: "tool" }> | undefined; yield { type: "delta", text: result?.result.output === 5 ? "sum accepted" : "sum missing" }; } yield { type: "completed" }; }
}
