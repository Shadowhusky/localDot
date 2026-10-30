import { createHash } from "node:crypto";
import { type LocalDotEvent, NOTES_FILE, ULID_PATTERN } from "@localdot/protocol";
import type { MemoryStore, NotesFile } from "../agent/memory.ts";
import { parseMemory } from "../agent/memory-entries.ts";
import type { EventLog } from "../event-log.ts";
import type { SearchDoc, SearchIndex, SearchKind } from "./search-index.ts";

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

// What a task's event adds to search. Never tool output, screenshots, thoughts, patches, typed
// text, approvals or key uses: only what the user said, what dot answered and named, and steps.
export function docsOf(sessionId: string, startedAt: string, e: LocalDotEvent): SearchDoc[] {
  const base = Date.parse(startedAt);
  const at = new Date((Number.isFinite(base) ? base : 0) + Math.floor(e.t / 1000)).toISOString();
  const doc = (kind: SearchKind, ref: string, text: string): SearchDoc => ({
    kind,
    sessionId,
    at,
    ref,
    text,
  });
  switch (e.type) {
    case "session.start":
      return e.data.title ? [doc("title", "title", e.data.title)] : [];
    case "message.user":
      return [doc("user", `msg:${e.data.messageId}`, e.data.text)];
    case "ask.answer":
      return e.data.by === "user" && e.data.text
        ? [doc("user", `ask:${e.data.askId}`, e.data.text)]
        : [];
    case "message.assistant":
      return [doc("assistant", `msg:${e.data.messageId}`, e.data.text)];
    case "task.result":
      return [
        doc("summary", `result:${e.id}`, e.data.summary),
        ...e.data.files.map((f) => doc("file", `file:${f.name}`, f.name)),
      ];
    case "plan.set":
      return e.data.items.map((item) => doc("step", `plan:${short(item.text)}`, item.text));
    case "tool.start":
      return e.data.tool === "recall" || e.data.tool === "people"
        ? []
        : [doc("step", `tool:${e.step ?? e.id}`, e.data.title)];
    case "action.intent":
      return e.data.verb === "type" ? [] : [doc("step", `action:${e.step ?? e.id}`, e.data.label)];
    default:
      return [];
  }
}

// A message the user cancelled or took back, or that Stop left unanswered, was never said to dot.
function unsaidOf(e: LocalDotEvent): string | undefined {
  return e.type === "message.delivery" &&
    (e.data.state === "cancelled" || e.data.state === "withdrawn")
    ? `msg:${e.data.messageId}`
    : undefined;
}

export function notesDocs(file: string, text: string): SearchDoc[] {
  const day = file.slice(6, 16);
  return parseMemory(text).flatMap((b, i): SearchDoc[] => {
    if (b.kind === "entry")
      return [
        {
          kind: "note",
          sessionId: b.meta.src && ULID_PATTERN.test(b.meta.src) ? b.meta.src : "",
          at: b.meta.at ?? day,
          ref: `${file}#${b.id}`,
          text: b.text,
        },
      ];
    const prose = b.raw
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith("#"))
      .join("\n")
      .trim();
    return prose
      ? [{ kind: "note", sessionId: "", at: day, ref: `${file}#raw${i}`, text: prose }]
      : [];
  });
}

export class SearchFeed {
  #complete = false;
  readonly #progress = new Map<string, number>();
  // One lookup per task, not one per event: the listener runs inside every EventLog.append.
  readonly #started = new Map<string, string>();
  constructor(
    private readonly deps: {
      index: SearchIndex;
      eventLog: Pick<
        EventLog,
        "read" | "listSessions" | "subscribe" | "hasSession" | "sessionInfo"
      >;
      notes: Pick<MemoryStore, "listNotes" | "read">;
      yieldEvery?: number;
    },
  ) {}
  get complete(): boolean {
    return this.#complete;
  }
  start(): () => void {
    const off = this.deps.eventLog.subscribe((id, e) => this.#onEvent(id, e));
    void this.backfill().catch(() => console.error("search: backfill could not complete"));
    return off;
  }
  #startedAt(id: string): string {
    let at = this.#started.get(id);
    if (at === undefined) {
      at = this.deps.eventLog.sessionInfo([id]).get(id)?.startedAt ?? new Date(0).toISOString();
      this.#started.set(id, at);
    }
    return at;
  }
  #onEvent(id: string, e: LocalDotEvent): void {
    if (e.type === "memory.change" && NOTES_FILE.test(e.data.file)) this.reindexNotes(e.data.file);
    const expected = this.#progress.get(id) ?? this.deps.index.progressOf(id);
    if (e.seq !== expected) {
      this.catchUp(id);
      return;
    }
    const unsaid = unsaidOf(e);
    if (unsaid) this.deps.index.remove(id, "user", unsaid);
    const docs = docsOf(id, this.#startedAt(id), e);
    if (docs.length) this.deps.index.add(docs, { sessionId: id, seq: e.seq + 1 });
    this.#progress.set(id, e.seq + 1);
  }
  catchUp(sessionId: string): void {
    const from = this.#progress.get(sessionId) ?? this.deps.index.progressOf(sessionId);
    const events = this.deps.eventLog.read(sessionId, from);
    const last = events.at(-1);
    if (!last) return;
    const startedAt = this.#startedAt(sessionId);
    for (const e of events) {
      const unsaid = unsaidOf(e);
      if (unsaid) this.deps.index.remove(sessionId, "user", unsaid);
    }
    this.deps.index.add(
      events.flatMap((e) => docsOf(sessionId, startedAt, e)),
      { sessionId, seq: last.seq + 1 },
    );
    this.#progress.set(sessionId, last.seq + 1);
  }
  reindexNotes(file: string): void {
    if (!NOTES_FILE.test(file)) return;
    this.deps.index.replaceNotes(file, notesDocs(file, this.deps.notes.read(file as NotesFile)));
  }
  async backfill(): Promise<void> {
    this.deps.index.pruneOrphans();
    let n = 0;
    for (const s of this.deps.eventLog.listSessions()) {
      if (!this.deps.eventLog.hasSession(s.id)) continue;
      try {
        this.catchUp(s.id);
      } catch {
        // An unreadable log is skipped; the next start retries it.
      }
      if (++n % (this.deps.yieldEvery ?? 20) === 0) await new Promise<void>((r) => setImmediate(r));
    }
    for (const file of this.deps.notes.listNotes()) this.reindexNotes(file);
    this.#complete = true;
  }
}
