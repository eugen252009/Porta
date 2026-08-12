import { InputAdapter, InputMessage, ModelDescriptor, ModelEvent, ModelProvider, ModelRequest, ModelContext, Renderer, PresentationEvent, Storage, Session, TelemetryEvent, TelemetrySink } from "./contracts.js";

export class MockModelProvider implements ModelProvider {
  readonly descriptor: ModelDescriptor = { id: "mock", version: "1", capabilities: [{ id: "model.streaming", version: "1" }] };
  constructor(private readonly output: string | ((input: string) => string) = (input) => input) {}
  async *generate(request: ModelRequest, context: ModelContext): AsyncIterable<ModelEvent> {
    if (request.input === "error") throw new Error("scripted model failure");
    const text = typeof this.output === "function" ? this.output(request.input) : this.output;
    for (const part of text.split(" ")) { if (context.signal.aborted || (context.deadline !== undefined && Date.now() >= context.deadline)) return; yield { type: "delta", text: `${part}${part === text.split(" ").at(-1) ? "" : " "}` }; }
    yield { type: "completed" };
  }
}
export class MemoryStore implements Storage { private readonly sessions = new Map<string, Session>(); async createSession(session: Session) { this.sessions.set(session.id, { ...session }); } async getSession(id: string) { const session = this.sessions.get(id); return session ? { ...session } : undefined; } async closeSession(id: string) { const session = this.sessions.get(id); if (session) this.sessions.set(id, { ...session, state: "closed" }); } }
export class ScriptInput implements InputAdapter { constructor(private readonly messages: readonly InputMessage[]) {} async *input() { yield* this.messages; } }
export class RecordingRenderer implements Renderer { readonly events: PresentationEvent[] = []; async render(event: PresentationEvent) { this.events.push(event); } }
export class NullTelemetry implements TelemetrySink { async emit(_event: TelemetryEvent) {} }
