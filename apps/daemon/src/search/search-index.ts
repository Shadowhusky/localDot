import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { EventLog } from "../event-log.ts";
import { DatabaseSync, type StatementSync } from "../sqlite.ts";
import { clipSnippet, escapeLike, ftsMatch, hasCjk, likeSnippet, searchTerms } from "./query.ts";
import { redactForIndex } from "./redact-index.ts";

export type SearchKind = "title" | "user" | "assistant" | "summary" | "step" | "file" | "note";
// sessionId is "" for a daily note no task wrote; at is ISO for tasks and YYYY-MM-DD for notes.
export interface SearchDoc {
  kind: SearchKind;
  sessionId: string;
  at: string;
  ref: string;
  text: string;
}
export interface SearchRow {
  sessionId: string | null;
  title: string | null;
  startedAt: string | null;
  kind: SearchKind;
  at: string;
  snippet: string;
  context?: string;
}
interface Hit {
  sessionId: string;
  kind: SearchKind;
  at: string;
  snippet: string;
}
const TEXT_MAX = 20_000;
// bm25() can't run inside a subquery the planner flattens into an aggregate, so hits are
// materialized first; each task's best row stands for it, and each daily note stands alone.
const RANKED = `WITH hits AS MATERIALIZED (
  SELECT CASE WHEN kind = 'note' THEN 'note:' || ref ELSE session_id END AS g, session_id, kind, at,
    bm25(docs) * CASE kind WHEN 'title' THEN 3.0 WHEN 'summary' THEN 2.0 WHEN 'user' THEN 1.5 ELSE 1.0 END AS score,
    snippet(docs, 4, char(57344), char(57345), '…', 12) AS snip
  FROM docs WHERE docs MATCH ?1 AND (?2 IS NULL OR kind = ?2) AND (?3 IS NULL OR session_id <> ?3)
) SELECT g, session_id, kind, at, MIN(score) AS score, snip FROM hits GROUP BY g ORDER BY score LIMIT ?4`;

// What earlier tasks said, redacted before it is stored, in the daemon's index.sqlite.
export class SearchIndex {
  readonly mode: "fts" | "like";
  readonly #db: DatabaseSync;
  readonly #sessions: Pick<EventLog, "sessionInfo">;
  readonly #key: StatementSync;
  readonly #row: StatementSync;
  readonly #progress: StatementSync;
  readonly #progressOf: StatementSync;
  constructor(
    home: string,
    opts: { sessions: Pick<EventLog, "sessionInfo">; forceLike?: boolean },
  ) {
    this.#sessions = opts.sessions;
    const file = join(home, "index.sqlite");
    this.#db = new DatabaseSync(file, { timeout: 2000 });
    for (const suffix of ["", "-journal", "-wal", "-shm"])
      if (existsSync(`${file}${suffix}`)) chmodSync(`${file}${suffix}`, 0o600);
    this.#db.exec("PRAGMA secure_delete = ON");
    this.mode = !opts.forceLike && this.#ftsAvailable() ? "fts" : "like";
    this.#db.exec(
      this.mode === "fts"
        ? "CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(kind UNINDEXED, session_id UNINDEXED, at UNINDEXED, ref UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');"
        : "CREATE TABLE IF NOT EXISTS docs_plain(kind TEXT NOT NULL, session_id TEXT NOT NULL, at TEXT NOT NULL, ref TEXT NOT NULL, text TEXT NOT NULL);",
    );
    // A deleted row's tokens leave the FTS index at once, not at the next merge.
    if (this.mode === "fts")
      this.#db.exec("INSERT INTO docs(docs, rank) VALUES('secure-delete', 1)");
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS doc_keys(session_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, PRIMARY KEY(session_id, kind, ref)); CREATE TABLE IF NOT EXISTS doc_progress(session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);",
    );
    this.#key = this.#db.prepare(
      "INSERT OR IGNORE INTO doc_keys(session_id, kind, ref) VALUES (?, ?, ?)",
    );
    this.#row = this.#db.prepare(
      `INSERT INTO ${this.#table}(kind, session_id, at, ref, text) VALUES (?, ?, ?, ?, ?)`,
    );
    this.#progress = this.#db.prepare(
      "INSERT INTO doc_progress(session_id, seq) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET seq = max(seq, excluded.seq)",
    );
    this.#progressOf = this.#db.prepare("SELECT seq FROM doc_progress WHERE session_id = ?");
  }
  get #table() {
    return this.mode === "fts" ? "docs" : "docs_plain";
  }
  #ftsAvailable(): boolean {
    try {
      this.#db.exec(
        "CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x); DROP TABLE temp.fts5_probe;",
      );
      return true;
    } catch {
      return false;
    }
  }
  #tx<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = work();
      this.#db.exec("COMMIT");
      return out;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  // The only way text enters the index, so it is always redacted first.
  add(docs: readonly SearchDoc[], progress?: { sessionId: string; seq: number }): number {
    return this.#tx(() => {
      let added = 0;
      for (const d of docs) {
        const text = redactForIndex(d.text).slice(0, TEXT_MAX).trim();
        if (!text) continue;
        if (Number(this.#key.run(d.sessionId, d.kind, d.ref).changes) !== 1) continue;
        this.#row.run(d.kind, d.sessionId, d.at, d.ref, text);
        added++;
      }
      if (progress) this.#progress.run(progress.sessionId, progress.seq);
      return added;
    });
  }
  progressOf(sessionId: string): number {
    const row = this.#progressOf.get(sessionId) as { seq?: number } | undefined;
    return Number(row?.seq ?? 0);
  }
  replaceNotes(file: string, docs: readonly SearchDoc[]): void {
    const prefix = `${file}#`;
    this.#tx(() => {
      for (const table of [this.#table, "doc_keys"])
        this.#db
          .prepare(`DELETE FROM ${table} WHERE kind = 'note' AND substr(ref, 1, ?) = ?`)
          .run(prefix.length, prefix);
    });
    this.add(docs);
  }
  search(q: {
    query: string;
    kind?: SearchKind;
    limit?: number;
    excludeSessionId?: string;
    details?: boolean;
  }): SearchRow[] {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
    const terms = searchTerms(q.query);
    if (!terms.length) return [];
    const kind = q.kind ?? null;
    const exclude = q.excludeSessionId ?? null;
    if (q.details) return this.#details(terms, kind, exclude, limit);
    const raw =
      this.mode === "fts" && !terms.some(hasCjk)
        ? (
            this.#db.prepare(RANKED).all(ftsMatch(terms), kind, exclude, limit * 2) as {
              session_id: string;
              kind: SearchKind;
              at: string;
              snip: string;
            }[]
          ).map((r) => ({ sessionId: r.session_id, kind: r.kind, at: r.at, snippet: r.snip }))
        : this.#like(terms, kind, exclude, limit * 2);
    const info = this.#sessions.sessionInfo(raw.flatMap((r) => (r.sessionId ? [r.sessionId] : [])));
    return raw
      .flatMap((r): SearchRow[] => {
        const s = r.sessionId ? info.get(r.sessionId) : undefined;
        if (!s && r.kind !== "note") return [];
        return [
          {
            sessionId: s ? r.sessionId : null,
            title: s?.title ?? null,
            startedAt: s?.startedAt ?? null,
            kind: r.kind,
            at: r.at,
            snippet: clipSnippet(r.snippet),
          },
        ];
      })
      .slice(0, limit);
  }
  // Recall needs the original redacted message, not a twelve-word search-card snippet.
  // Do not group by task: a title or summary must not hide the user's configuration/correction.
  #details(
    terms: readonly string[],
    kind: SearchKind | null,
    exclude: string | null,
    limit: number,
  ): SearchRow[] {
    const fts = this.mode === "fts" && !terms.some(hasCjk);
    const where = fts ? "docs MATCH ?" : terms.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ");
    const rows = this.#db
      .prepare(
        `SELECT kind, session_id, at, text FROM ${this.#table} WHERE ${where}
       AND (? IS NULL OR kind = ?) AND (? IS NULL OR session_id <> ?)
       ORDER BY CASE kind WHEN 'user' THEN 0 WHEN 'note' THEN 1 ELSE 2 END, at DESC, rowid DESC LIMIT ?`,
      )
      .all(
        ...(fts ? [ftsMatch(terms)] : terms.map((term) => `%${escapeLike(term)}%`)),
        kind,
        kind,
        exclude,
        exclude,
        limit * 2,
      ) as {
      kind: SearchKind;
      session_id: string;
      at: string;
      text: string;
    }[];
    const info = this.#sessions.sessionInfo(
      rows.flatMap((r) => (r.session_id ? [r.session_id] : [])),
    );
    let remaining = 20_000;
    return rows
      .flatMap((r): SearchRow[] => {
        const session = r.session_id ? info.get(r.session_id) : undefined;
        if ((!session && r.kind !== "note") || remaining <= 0) return [];
        // Apply current redaction rules again to indexes written by older versions.
        const safe = redactForIndex(r.text);
        const lower = safe.toLowerCase();
        const at = Math.max(0, lower.indexOf(terms.find((term) => lower.includes(term)) ?? ""));
        const from = Math.max(0, at - 1500);
        const size = Math.min(8000, remaining);
        const context = `${from ? "[Earlier text omitted]\n" : ""}${safe.slice(from, from + size)}${from + size < safe.length ? "\n[More text omitted; narrow the recall query]" : ""}`;
        remaining -= context.length;
        return [
          {
            sessionId: session ? r.session_id : null,
            title: session?.title ?? null,
            startedAt: session?.startedAt ?? null,
            kind: r.kind,
            at: r.at,
            snippet: clipSnippet(likeSnippet(safe, terms)),
            context,
          },
        ];
      })
      .slice(0, limit);
  }

  #like(terms: readonly string[], kind: SearchKind | null, exclude: string | null, limit: number) {
    const where = terms.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ");
    const rows = this.#db
      .prepare(
        `SELECT kind, session_id, at, ref, text FROM ${this.#table} WHERE ${where} AND (? IS NULL OR kind = ?) AND (? IS NULL OR session_id <> ?) ORDER BY at DESC LIMIT 500`,
      )
      .all(...terms.map((t) => `%${escapeLike(t)}%`), kind, kind, exclude, exclude) as {
      kind: SearchKind;
      session_id: string;
      at: string;
      ref: string;
      text: string;
    }[];
    const seen = new Set<string>();
    const out: Hit[] = [];
    for (const r of rows) {
      const group = r.kind === "note" ? `note:${r.ref}` : r.session_id;
      if (seen.has(group)) continue;
      seen.add(group);
      out.push({
        sessionId: r.session_id,
        kind: r.kind,
        at: r.at,
        snippet: likeSnippet(r.text, terms),
      });
      if (out.length >= limit) break;
    }
    return out;
  }
  // Rows a deletion that crashed half way left behind. No `optimize`: secure-delete already
  // purges tokens, and a full merge at every start is slow on a big index.
  pruneOrphans(): void {
    this.#tx(() => {
      for (const table of [this.#table, "doc_keys"])
        this.#db.exec(
          `DELETE FROM ${table} WHERE kind <> 'note' AND session_id NOT IN (SELECT id FROM sessions)`,
        );
      this.#db.exec("DELETE FROM doc_progress WHERE session_id NOT IN (SELECT id FROM sessions)");
    });
  }
  close(): void {
    this.#db.close();
  }
}
