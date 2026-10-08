import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BROWSER_RECORDING_DIR,
  RECORDING_DIR,
  RECORDING_MANIFEST,
  SessionCard,
  type SessionIndexPage,
  ULID_PATTERN,
} from "@localdot/protocol";
import { UnknownSessionError } from "../event-log.ts";
import { DatabaseSync } from "../sqlite.ts";
import { readSummary, recordingCards, summarizeSession, writeSummary } from "./summary.ts";
export const INDEX_PAGE_MAX = 100;
interface Row {
  id: string;
  card: string;
  log_bytes: number;
  manifest_mtime_ms: number;
  browser_manifest_mtime_ms: number;
}
function cursor(before: string): [string, string] {
  const parts = before.split("~");
  if (
    parts.length !== 2 ||
    !ULID_PATTERN.test(parts[1] ?? "") ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parts[0] ?? "") ||
    !Number.isFinite(Date.parse(parts[0] ?? ""))
  )
    throw new RangeError("invalid session cursor");
  return [parts[0] as string, parts[1] as string];
}
export class SessionIndex {
  readonly #home: string;
  readonly #isLive: (id: string) => boolean;
  readonly #db: DatabaseSync;
  constructor(home: string, opts: { isLive(id: string): boolean }) {
    this.#home = home;
    this.#isLive = opts.isLive;
    this.#db = new DatabaseSync(join(home, "index.sqlite"));
    this.#db.exec(
      "PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS session_cards(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, card TEXT NOT NULL, log_bytes INTEGER NOT NULL, manifest_mtime_ms INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS session_cards_started ON session_cards(started_at DESC,id DESC);",
    );
    if (
      !this.#db
        .prepare("PRAGMA table_info(session_cards)")
        .all()
        .some((column) => column.name === "browser_manifest_mtime_ms")
    ) {
      this.#db.exec(
        "ALTER TABLE session_cards ADD COLUMN browser_manifest_mtime_ms REAL NOT NULL DEFAULT -1",
      );
    }
  }
  async #refresh(id: string): Promise<SessionCard> {
    if (!ULID_PATTERN.test(id)) throw new RangeError("invalid session id");
    const dir = join(this.#home, "sessions", id);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UnknownSessionError(id);
    const bytes = statSync(join(dir, "events.jsonl"), { throwIfNoEntry: false })?.size ?? 0;
    const mtime =
      statSync(join(dir, RECORDING_DIR, RECORDING_MANIFEST), { throwIfNoEntry: false })?.mtimeMs ??
      0;
    const live = this.#isLive(id);
    const browserMtime =
      statSync(join(dir, BROWSER_RECORDING_DIR, RECORDING_MANIFEST), { throwIfNoEntry: false })
        ?.mtimeMs ?? 0;
    const row = this.#db.prepare("SELECT * FROM session_cards WHERE id = ?").get(id) as unknown as
      | Row
      | undefined;
    if (
      !live &&
      row &&
      row.log_bytes === bytes &&
      row.manifest_mtime_ms === mtime &&
      row.browser_manifest_mtime_ms === browserMtime
    ) {
      try {
        const card = SessionCard.parse(JSON.parse(row.card));
        if (card.verdict !== "live" && card.recordings) return card;
      } catch {
        /* regenerate a damaged cache row */
      }
    }
    const saved = live ? null : readSummary(this.#home, id);
    const recordings = recordingCards(this.#home, id);
    const summary =
      saved?.logBytes === bytes
        ? { ...saved, recording: recordings.desktop, recordings }
        : await summarizeSession(this.#home, id, { live });
    const card = SessionCard.parse(summary);
    if (!live) writeSummary(this.#home, summary);
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO session_cards(id,started_at,card,log_bytes,manifest_mtime_ms,browser_manifest_mtime_ms) VALUES (?,?,?,?,?,?)",
      )
      .run(id, card.startedAt, JSON.stringify(card), summary.logBytes, mtime, browserMtime);
    return card;
  }
  async page(opts: { before?: string; limit?: number } = {}): Promise<SessionIndexPage> {
    const limit = opts.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > INDEX_PAGE_MAX)
      throw new RangeError("invalid page size");
    const before = opts.before === undefined ? undefined : cursor(opts.before);
    const dirs = readdirSync(join(this.#home, "sessions"), { withFileTypes: true }).filter(
      (d) => d.isDirectory() && ULID_PATTERN.test(d.name),
    );
    const ids = new Set(dirs.map((d) => d.name));
    for (const row of this.#db.prepare("SELECT id FROM session_cards").all())
      if (!ids.has(String(row.id))) this.invalidate(String(row.id));
    for (const id of ids) await this.#refresh(id);
    const rows = (before
      ? this.#db
          .prepare(
            "SELECT * FROM session_cards WHERE (started_at,id) < (?,?) ORDER BY started_at DESC,id DESC LIMIT ?",
          )
          .all(...before, limit + 1)
      : this.#db
          .prepare("SELECT * FROM session_cards ORDER BY started_at DESC,id DESC LIMIT ?")
          .all(limit + 1)) as unknown as Row[];
    const sessions = rows.slice(0, limit).map((row) => SessionCard.parse(JSON.parse(row.card)));
    const last = sessions.at(-1);
    return { sessions, next: rows.length > limit && last ? `${last.startedAt}~${last.id}` : null };
  }
  card(id: string): Promise<SessionCard> {
    return this.#refresh(id);
  }
  invalidate(id: string): void {
    this.#db.prepare("DELETE FROM session_cards WHERE id = ?").run(id);
  }
  close(): void {
    this.#db.close();
  }
}
