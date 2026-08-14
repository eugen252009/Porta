import { ConversationBudget, ConversationSession, ConversationSnapshot, ConversationStore, ConversationTurn, HarnessFailure, Session } from "./contracts.js";

export class MemoryConversationStore implements ConversationStore {
  private readonly sessions = new Map<string, { session: Session; turns: ConversationTurn[] }>();
  constructor(private readonly budget: ConversationBudget = {}) {}
  createSession(session: ConversationSession): Promise<void> {
    if (this.sessions.has(session.id)) throw new HarnessFailure({ code: "CAPABILITY_CONFLICT", message: `Session '${session.id}' already exists.`, retryable: false });
    this.sessions.set(session.id, { session: { schemaVersion: 1, id: session.id, state: session.state, createdAt: session.createdAt }, turns: session.turns.map(cloneTurn) });
    return Promise.resolve();
  }
  async getSession(id: string): Promise<ConversationSession | undefined> {
    const entry = this.sessions.get(id); if (!entry) return undefined;
    const turns = entry.turns.map(cloneTurn);
    return freeze({ ...entry.session, history: turns.flatMap((turn) => turn.messages), turns });
  }
  async closeSession(id: string): Promise<void> {
    const entry = this.sessions.get(id); if (!entry) return;
    entry.session = { ...entry.session, state: "closed" };
  }
  async commitTurn(id: string, turn: ConversationTurn): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry || entry.session.state !== "open") throw new HarnessFailure({ code: "STORAGE_FAILED", message: `Session '${id}' is unavailable.`, retryable: false });
    if (!turn.messages.length) throw new HarnessFailure({ code: "VALIDATION_FAILED", message: "Conversation turn cannot be empty.", retryable: false });
    entry.turns.push(cloneTurn(turn));

  }
  async snapshot(id: string): Promise<ConversationSnapshot> {
    const entry = this.sessions.get(id);
    if (!entry || entry.session.state !== "open") throw new HarnessFailure({ code: "STORAGE_FAILED", message: `Session '${id}' is unavailable.`, retryable: false });
    const turns = entry.turns.map(cloneTurn);
    const maxTurns = this.budget.maxTurns;
    const included = maxTurns === undefined ? turns : turns.slice(Math.max(0, turns.length - maxTurns));
    return freeze({ history: included.flatMap((turn) => turn.messages), turns, turnsAvailable: turns.length, turnsIncluded: included.length, turnsDropped: turns.length - included.length });
  }
  openSessionIds(): readonly string[] { return [...this.sessions.values()].filter((entry) => entry.session.state === "open").map((entry) => entry.session.id); }
}

export function sessionFromBase(session: Session): ConversationSession { return freeze({ ...session, history: [], turns: [] }); }
function cloneTurn(turn: ConversationTurn): ConversationTurn { return freeze({ messages: turn.messages.map((message) => clone(message)) }); }
function clone<T>(value: T): T { if (Array.isArray(value)) return freeze(value.map((item) => clone(item))) as T; if (value && typeof value === "object") return freeze(Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, clone(child)]))) as T; return value; }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; }
