import { ConversationTurn, HarnessFailure, ModelProvider, ToolContext } from "./contracts.js";

export interface ConversationCompactionRequest { readonly turns: readonly ConversationTurn[]; readonly compactedThrough: number; readonly maxChars?: number }
export interface ConversationCompactionResult { readonly summary: string; readonly compactedThrough: number }
export interface ConversationCompactor { compact(request: ConversationCompactionRequest, context: ToolContext): Promise<ConversationCompactionResult> }

export class DeterministicConversationCompactor implements ConversationCompactor {
  async compact(request: ConversationCompactionRequest, context: ToolContext): Promise<ConversationCompactionResult> {
    if (context.signal.aborted) throw new HarnessFailure({ code: "CANCELLED", message: "Conversation compaction was cancelled.", retryable: false });
    const lines = request.turns.map((turn, index) => {
      const detail = turn.messages.map((message) => message.role === "user" ? `user: ${message.content}` : message.role === "assistant" ? `assistant: ${message.content ?? "[tool call]"}` : `tool ${message.toolId}: ${JSON.stringify(message.result.output)}`).join(" | ");
      return `Turn ${index + 1}: ${detail}`;
    });
    return { summary: limit(`Compacted conversation summary:\n${lines.join("\n")}`, request.maxChars), compactedThrough: request.compactedThrough };
  }
}

export class ModelConversationCompactor implements ConversationCompactor {
  constructor(private readonly model: ModelProvider) {}
  async compact(request: ConversationCompactionRequest, context: ToolContext): Promise<ConversationCompactionResult> {
    const source = request.turns.map((turn, index) => `Turn ${index + 1}: ${JSON.stringify(turn.messages)}`).join("\n");
    const prompt = `Summarize this completed conversation history faithfully. Preserve the user's goal, important decisions, constraints, results, unresolved questions, and relevant tool outcomes. Do not invent details. This is context preparation, not a user turn. Keep the summary under ${request.maxChars ?? 12000} characters.\n\n${source}`;
    let summary = "";
    for await (const event of this.model.generate({ schemaVersion: 1, requestId: `compaction-${context.executionId}`, input: prompt }, { ...context, executionId: `${context.executionId}:compaction` })) {
      if (event.type === "delta") summary += event.text;
      if (event.type === "tool-call") throw new HarnessFailure({ code: "MODEL_FAILED", message: "Conversation compactor attempted a tool call.", retryable: false });
    }
    if (!summary) throw new HarnessFailure({ code: "MODEL_FAILED", message: "Conversation compactor returned an empty summary.", retryable: false });
    return { summary: limit(summary, request.maxChars), compactedThrough: request.compactedThrough };
  }
}
function limit(value: string, maxChars = 12000): string { return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 24))}… [compaction truncated]`; }
