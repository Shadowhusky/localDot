import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import {
  type EventDraft,
  type LocalDotEvent,
  parseEvent,
  ULID_PATTERN,
  ulid,
} from "@localdot/protocol";
import { type Clock, monotonicClock } from "./clock.ts";
import { DatabaseSync, type StatementSync } from "./sqlite.ts";

export interface SessionSummary {
  id: string;
  title: string | null;
  startedAt: string;
  events: number;
}

export type EventListener = (sessionId: string, event: LocalDotEvent) => void;

interface SessionState {
  file: string;
  seq: number;
  lastT: number;
  origin: number;
}

export class EventLog {
  readonly #root: string;
  readonly #clock: Clock;
  readonly #db: DatabaseSync;
  readonly #insertEvent: StatementSync;
  readonly #states = new Map<string, SessionState>();
  readonly #listeners = new Set<EventListener>();

  constructor(home: string, clock: Clock = monotonicClock()) {
    this.#root = join(home, "sessions");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.#clock = clock;
    this.#db = new DatabaseSync(join(home, "index.sqlite"));
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, started_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, t INTEGER NOT NULL,
        type TEXT NOT NULL, step TEXT, agent TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
    this.#insertEvent = this.#db.prepare(
      "INSERT OR IGNORE INTO events (session_id, seq, t, type, step, agent) VALUES (?, ?, ?, ?, ?, ?)",
    );
  }

  createSession(title?: string): string {
    const id = ulid();
    mkdirSync(join(this.#root, id), { recursive: true, mode: 0o700 });
    this.#db
      .prepare("INSERT INTO sessions (id, title, started_at) VALUES (?, ?, ?)")
      .run(id, title ?? null, new Date().toISOString());
    this.#states.set(id, {
      file: this.#fileOf(id),
      seq: 0,
      lastT: 0,
      origin: this.#clock.nowMicros(),
    });
    return id;
  }

  append(sessionId: string, draft: EventDraft): LocalDotEvent {
    const state = this.#stateOf(sessionId);
    const t = Math.max(state.lastT, this.#clock.nowMicros() - state.origin);
    const event = parseEvent({ ...draft, v: 1, id: ulid(), seq: state.seq, t });
    appendFileSync(state.file, `${JSON.stringify(event)}\n`);
    this.#index(sessionId, event);
    state.seq += 1;
    state.lastT = t;
    for (const listener of this.#listeners) listener(sessionId, event);
    return event;
  }

  read(sessionId: string, fromSeq = 0): LocalDotEvent[] {
    return readValid(this.#fileOf(sessionId)).events.filter((e) => e.seq >= fromSeq);
  }

  listSessions(): SessionSummary[] {
    return this.#db
      .prepare(`
        SELECT s.id AS id, s.title AS title, s.started_at AS startedAt, COUNT(e.seq) AS events
        FROM sessions s LEFT JOIN events e ON e.session_id = s.id
        GROUP BY s.id ORDER BY s.started_at DESC
      `)
      .all() as unknown as SessionSummary[];
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#db.close();
  }

  #fileOf(sessionId: string): string {
    if (!ULID_PATTERN.test(sessionId)) throw new Error("invalid session id");
    return join(this.#root, sessionId, "events.jsonl");
  }

  #stateOf(sessionId: string): SessionState {
    const cached = this.#states.get(sessionId);
    if (cached) return cached;
    const file = this.#fileOf(sessionId);
    if (!existsSync(join(this.#root, sessionId))) throw new Error(`unknown session ${sessionId}`);
    const { events, validBytes } = readValid(file);
    // A crash can leave a partial last line; cut it so the next append starts on a clean line.
    if (existsSync(file)) truncateSync(file, validBytes);
    for (const event of events) this.#index(sessionId, event);
    const last = events.at(-1);
    const lastT = last?.t ?? 0;
    const state = {
      file,
      seq: (last?.seq ?? -1) + 1,
      lastT,
      origin: this.#clock.nowMicros() - lastT - 1,
    };
    this.#states.set(sessionId, state);
    return state;
  }

  #index(sessionId: string, event: LocalDotEvent): void {
    this.#insertEvent.run(
      sessionId,
      event.seq,
      event.t,
      event.type,
      event.step ?? null,
      event.agent,
    );
  }
}

function readValid(file: string): { events: LocalDotEvent[]; validBytes: number } {
  if (!existsSync(file)) return { events: [], validBytes: 0 };
  const text = readFileSync(file, "utf8");
  const events: LocalDotEvent[] = [];
  let validBytes = 0;
  let start = 0;
  for (let end = text.indexOf("\n", start); end !== -1; end = text.indexOf("\n", start)) {
    const line = text.slice(start, end);
    try {
      events.push(parseEvent(JSON.parse(line)));
    } catch {
      break;
    }
    validBytes += Buffer.byteLength(line) + 1;
    start = end + 1;
  }
  return { events, validBytes };
}
