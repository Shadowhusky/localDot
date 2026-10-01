import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type EventDraft,
  type LocalDotEvent,
  parseEvent,
  ULID_PATTERN,
  ulid,
  ulidTime,
} from "@localdot/protocol";
import { type Clock, monotonicClock } from "./clock.ts";
import { DatabaseSync, type StatementSync } from "./sqlite.ts";

const BUSY_TIMEOUT_MS = 2000;

export interface SessionSummary {
  id: string;
  title: string | null;
  startedAt: string;
  events: number;
}

export interface SessionMeta {
  id: string;
  title: string | null;
  startedAt: string;
}

export type EventListener = (sessionId: string, event: LocalDotEvent) => void;

export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`unknown session ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}

interface SessionState {
  file: string;
  bytes: number;
  seq: number;
  lastT: number;
  origin: number;
  indexStale: boolean;
}

export class EventLog {
  readonly #root: string;
  readonly #clock: Clock;
  readonly #db: DatabaseSync;
  readonly #insertEvent: StatementSync;
  readonly #deleteEvents: StatementSync;
  readonly #states = new Map<string, SessionState>();
  readonly #listeners = new Set<EventListener>();

  constructor(home: string, clock: Clock = monotonicClock()) {
    this.#root = join(home, "sessions");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.#clock = clock;
    const index = join(home, "index.sqlite");
    this.#db = new DatabaseSync(index, { timeout: BUSY_TIMEOUT_MS });
    // SQLite gives new journal files the database file's mode, so tightening these once suffices.
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      if (existsSync(`${index}${suffix}`)) chmodSync(`${index}${suffix}`, 0o600);
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, started_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, t INTEGER NOT NULL,
        type TEXT NOT NULL, step TEXT, agent TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
    this.#insertEvent = this.#db.prepare(
      "INSERT OR REPLACE INTO events (session_id, seq, t, type, step, agent) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.#deleteEvents = this.#db.prepare("DELETE FROM events WHERE session_id = ?");
    this.#recoverAll();
  }

  createSession(title?: string): string {
    const id = ulid();
    const dir = join(this.#root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const meta: SessionMeta = { id, title: title ?? null, startedAt: new Date().toISOString() };
    writeMeta(dir, meta);
    this.#db
      .prepare("INSERT INTO sessions (id, title, started_at) VALUES (?, ?, ?)")
      .run(id, meta.title, meta.startedAt);
    this.#states.set(id, {
      file: this.#fileOf(id),
      bytes: 0,
      seq: 0,
      lastT: 0,
      origin: this.#clock.nowMicros(),
      indexStale: false,
    });
    return id;
  }

  append(sessionId: string, draft: EventDraft): LocalDotEvent {
    const state = this.#stateOf(sessionId);
    const t = Math.max(state.lastT, this.#clock.nowMicros() - state.origin);
    const event = parseEvent({ ...draft, v: 1, id: ulid(), seq: state.seq, t });
    this.#write(sessionId, state, `${JSON.stringify(event)}\n`);
    state.seq += 1;
    state.lastT = t;
    this.#updateIndex(sessionId, state, () => {
      if (state.indexStale) this.#rebuildIndex(sessionId, readValid(state.file).events);
      else this.#insert(sessionId, event);
    });
    for (const listener of this.#listeners) {
      try {
        listener(sessionId, event);
      } catch (err) {
        console.error(`event listener failed for session ${sessionId}: ${String(err)}`);
      }
    }
    return event;
  }

  hasSession(sessionId: string): boolean {
    return ULID_PATTERN.test(sessionId) && existsSync(join(this.#root, sessionId));
  }

  read(sessionId: string, fromSeq = 0): LocalDotEvent[] {
    return readValid(this.#existingFileOf(sessionId)).events.filter((e) => e.seq >= fromSeq);
  }

  listSessions(): SessionSummary[] {
    return this.#db
      .prepare(`
        SELECT s.id AS id, s.title AS title, s.started_at AS startedAt, COUNT(e.seq) AS events
        FROM sessions s LEFT JOIN events e ON e.session_id = s.id
        GROUP BY s.id ORDER BY s.started_at DESC, s.id DESC
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

  #existingFileOf(sessionId: string): string {
    const file = this.#fileOf(sessionId);
    if (!this.hasSession(sessionId)) throw new UnknownSessionError(sessionId);
    return file;
  }

  #recoverAll(): void {
    for (const entry of readdirSync(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ULID_PATTERN.test(entry.name)) continue;
      try {
        this.#stateOf(entry.name);
      } catch (err) {
        console.error(`could not recover session ${entry.name}: ${String(err)}`);
      }
    }
  }

  #stateOf(sessionId: string): SessionState {
    const cached = this.#states.get(sessionId);
    // Bytes this log did not write (a stray or torn write) send the session back through recovery.
    if (cached && sizeOf(cached.file) === cached.bytes) return cached;
    const file = this.#existingFileOf(sessionId);
    const { events, validBytes } = readValid(file);
    if (existsSync(file)) truncateSync(file, validBytes);
    const lastSeq = events.reduce((max, e) => Math.max(max, e.seq), -1);
    const lastT = events.reduce((max, e) => Math.max(max, e.t), 0);
    const state: SessionState = {
      file,
      bytes: validBytes,
      seq: lastSeq + 1,
      lastT,
      origin: this.#clock.nowMicros() - lastT - 1,
      indexStale: false,
    };
    this.#states.set(sessionId, state);
    this.#updateIndex(sessionId, state, () => this.#rebuildIndex(sessionId, events));
    return state;
  }

  #write(sessionId: string, state: SessionState, line: string): void {
    try {
      appendFileSync(state.file, line, { mode: 0o600 });
    } catch (err) {
      try {
        truncateSync(state.file, state.bytes);
      } catch {
        // Forget the state so the next touch re-runs recovery, which drops the torn tail.
        this.#states.delete(sessionId);
      }
      throw err;
    }
    state.bytes += Buffer.byteLength(line);
  }

  // The JSONL file is the record; a failed index write only marks the index for a rebuild.
  #updateIndex(sessionId: string, state: SessionState, update: () => void): void {
    try {
      update();
      state.indexStale = false;
    } catch (err) {
      state.indexStale = true;
      console.error(`index update for session ${sessionId} failed, will rebuild: ${String(err)}`);
    }
  }

  #rebuildIndex(sessionId: string, events: LocalDotEvent[]): void {
    const meta = readMeta(join(this.#root, sessionId), sessionId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare("INSERT OR IGNORE INTO sessions (id, title, started_at) VALUES (?, ?, ?)")
        .run(meta.id, meta.title, meta.startedAt);
      this.#deleteEvents.run(sessionId);
      for (const event of events) this.#insert(sessionId, event);
      this.#db.exec("COMMIT");
    } catch (err) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  #insert(sessionId: string, event: LocalDotEvent): void {
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

function sizeOf(file: string): number {
  return statSync(file, { throwIfNoEntry: false })?.size ?? 0;
}

// Only the unterminated tail can be a torn write; a complete line that fails to parse is skipped.
function readValid(file: string): { events: LocalDotEvent[]; validBytes: number } {
  if (!existsSync(file)) return { events: [], validBytes: 0 };
  const bytes = readFileSync(file);
  const validBytes = bytes.lastIndexOf(0x0a) + 1;
  const events = bytes
    .subarray(0, validBytes)
    .toString("utf8")
    .split("\n")
    .flatMap((line) => parseLine(line) ?? []);
  return { events, validBytes };
}

function parseLine(line: string): LocalDotEvent | undefined {
  try {
    return parseEvent(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function writeMeta(dir: string, meta: SessionMeta): void {
  const file = join(dir, "session.json");
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(meta)}\n`, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

// A folder without session.json predates this file: its ULID carries the start time.
function readMeta(dir: string, id: string): SessionMeta {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as SessionMeta;
    if (meta.id === id && typeof meta.startedAt === "string") return meta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`session ${id}: unreadable session.json, deriving it: ${String(err)}`);
    }
  }
  const meta: SessionMeta = { id, title: null, startedAt: new Date(ulidTime(id)).toISOString() };
  writeMeta(dir, meta);
  return meta;
}
