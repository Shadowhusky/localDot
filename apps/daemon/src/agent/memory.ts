import { readdirSync } from "node:fs";
import { keyLikePresent, NOTES_FILE, ULID_PATTERN, ulid, unifiedDiff } from "@localdot/protocol";
import { z } from "zod";
import {
  bootView,
  entryTextProblem,
  eolOf,
  isEntry,
  localDay,
  type MemoryEntryBlock,
  parseMemory,
  renderEntry,
  replaceVisible,
  serializeMemory,
  stripComments,
  tagAppend,
} from "./memory-entries.ts";
import { PrivateFiles } from "./private-files.ts";

export type MemoryBook = "USER.md" | "MEMORY.md";
export type NotesFile = `notes/${string}.md`;
export type MemoryFile = MemoryBook | NotesFile;
export type EntrySource =
  | { kind: "task"; sessionId: string }
  | { kind: "user" }
  | { kind: "unknown" };
export interface StoredEntry {
  id: string;
  file: MemoryBook;
  text: string;
  source: EntrySource;
  at: string | null;
  pinned: boolean;
  revision: string;
}
export const MEMORY_MAX_CHARS = 20_000;
const Book = z.enum(["USER.md", "MEMORY.md"]);
const File = z.union([Book, z.string().regex(NOTES_FILE)]);
const Text = z
  .string()
  .max(MEMORY_MAX_CHARS)
  .refine((s) => s.isWellFormed() && !s.includes("\0"));
const Id = z.string().regex(ULID_PATTERN);
// Records written before entries existed have a sessionId and no source.
const History = z
  .strictObject({
    sessionId: Id.optional(),
    source: z.enum(["agent", "user"]).optional(),
    file: File,
    before: Text,
    after: Text,
    undone: z.boolean().optional(),
    undoes: Id.optional(),
  })
  .refine((h) => (h.source === "user") === (h.sessionId === undefined));
type History = z.infer<typeof History>;
const Pending = z.strictObject({ changeId: Id, history: History });
const TEMPLATES: Record<MemoryBook, string> = {
  "USER.md": "# About the user\n\n",
  "MEMORY.md": "# Things worth remembering\n\n",
};
const template = (file: MemoryFile) =>
  file === "USER.md" || file === "MEMORY.md"
    ? TEMPLATES[file]
    : `# Notes · ${file.slice(6, 16)}\n\n`;
export class MemoryError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}
export interface MemoryChangeRecord {
  changeId: string;
  sessionId?: string;
  source: "agent" | "user";
  file: MemoryFile;
  patch: string;
}

// Entries a replace rewrote are dot's text now: they carry this task and today, keeping their id
// and pin, so a fact dot changed never shows as the user's.
function stampChanged(
  before: string,
  after: string,
  src: string,
  day: string,
  eol: "\n" | "\r\n",
): string {
  const old = new Set(
    parseMemory(before)
      .filter(isEntry)
      .map((e) => e.raw),
  );
  return parseMemory(after)
    .map((b) =>
      b.kind === "entry" && !old.has(b.raw) && b.text
        ? renderEntry(
            b.text,
            {
              id: b.meta.id ?? ulid(),
              src,
              at: day,
              ...(b.meta.pin ? { pin: true as const } : {}),
            },
            eol,
          )
        : b.raw,
    )
    .join("");
}

export class MemoryStore {
  readonly #files: PrivateFiles;
  readonly #now: () => Date;
  constructor(home: string, opts: { now?: () => Date } = {}) {
    this.#files = new PrivateFiles(home, "memory");
    this.#now = opts.now ?? (() => new Date());
    this.#files.directory(".history");
    this.#files.directory("notes");
    this.#recover();
  }
  #read(file: MemoryFile): string {
    try {
      const text = this.#files.text(file, 80_000) ?? template(file);
      return Text.parse(text);
    } catch {
      throw new MemoryError(409, "memory file is invalid or exceeds its limit");
    }
  }
  read(file: MemoryFile): string {
    if (!File.safeParse(file).success) throw new MemoryError(400, "invalid memory file");
    this.#recover();
    return this.#read(file);
  }
  readBoth() {
    return { user: this.read("USER.md"), memory: this.read("MEMORY.md") };
  }
  // What a task's model reads: pinned facts first and no metadata. Daily notes never boot.
  bootMemory(): { user: string; memory: string } {
    return {
      user: bootView(this.read("USER.md"), MEMORY_MAX_CHARS),
      memory: bootView(this.read("MEMORY.md"), MEMORY_MAX_CHARS),
    };
  }
  #history(id: string): History {
    const text = this.#files.text(`.history/${id}.json`, 256 * 1024);
    if (text === undefined) throw new MemoryError(404, "no such memory change");
    try {
      return History.parse(JSON.parse(text));
    } catch {
      throw new MemoryError(409, "invalid memory history");
    }
  }
  apply(
    sessionId: string,
    file: MemoryBook,
    op: "append" | "replace",
    text: string,
    oldText?: string,
  ): MemoryChangeRecord {
    if (
      !Id.safeParse(sessionId).success ||
      !Book.safeParse(file).success ||
      !Text.safeParse(text).success ||
      (op !== "append" && op !== "replace")
    )
      throw new MemoryError(400, "invalid memory change");
    this.#recover();
    const before = this.#read(file);
    const clean = stripComments(text);
    const day = localDay(this.#now());
    let after: string;
    if (op === "append") {
      if (!clean.trim()) throw new MemoryError(400, "nothing to remember");
      const eol = eolOf(before);
      const sep = before === "" || before.endsWith("\n") ? "" : eol;
      after = `${before}${sep}${tagAppend(clean, sessionId, day, eol, ulid)}`;
    } else {
      if (!oldText || !Text.safeParse(oldText).success)
        throw new MemoryError(400, "replace needs nonempty valid old_text within the memory limit");
      const replaced = replaceVisible(before, oldText, clean);
      if (replaced === "missing") throw new MemoryError(409, `old_text is not in ${file}`);
      if (replaced === "ambiguous")
        throw new MemoryError(409, `old_text occurs more than once in ${file}`);
      after = stampChanged(before, replaced, sessionId, day, eolOf(before));
    }
    if (after.length > MEMORY_MAX_CHARS)
      throw new MemoryError(
        409,
        `${file} would pass ${MEMORY_MAX_CHARS} characters; replace older lines instead`,
      );
    if (after === before) throw new MemoryError(409, "memory did not change");
    return this.#commit({ sessionId, source: "agent", file, before, after });
  }
  appendNote(sessionId: string, text: string): MemoryChangeRecord {
    if (!Id.safeParse(sessionId).success || !Text.safeParse(text).success)
      throw new MemoryError(400, "invalid note");
    const clean = stripComments(text).trim();
    if (!clean || keyLikePresent(clean)) throw new MemoryError(400, "invalid note");
    this.#recover();
    const day = localDay(this.#now());
    const file: NotesFile = `notes/${day}.md`;
    const before = this.#read(file);
    const eol = eolOf(before);
    const sep = before === "" || before.endsWith("\n") ? "" : eol;
    const after = `${before}${sep}${tagAppend(clean, sessionId, day, eol, ulid)}`;
    if (after.length > MEMORY_MAX_CHARS) throw new MemoryError(409, "today's notes are full");
    return this.#commit({ sessionId, source: "agent", file, before, after });
  }
  listNotes(): NotesFile[] {
    return readdirSync(this.#files.directory("notes"))
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .sort()
      .reverse()
      .map((n) => `notes/${n}` as NotesFile);
  }
  #view(file: MemoryBook, e: MemoryEntryBlock): StoredEntry {
    const src = e.meta.src;
    return {
      id: e.id,
      file,
      text: e.text,
      source:
        src === "user"
          ? { kind: "user" }
          : src && ULID_PATTERN.test(src)
            ? { kind: "task", sessionId: src }
            : { kind: "unknown" },
      at: e.meta.at ?? null,
      pinned: Boolean(e.meta.pin),
      revision: e.revision,
    };
  }
  #checkText(text: string): void {
    if (entryTextProblem(text) || keyLikePresent(text))
      throw new MemoryError(400, "invalid memory entry text");
  }
  #userCommit(file: MemoryBook, before: string, after: string): MemoryChangeRecord {
    if (after.length > MEMORY_MAX_CHARS)
      throw new MemoryError(409, `${file} would pass ${MEMORY_MAX_CHARS} characters`);
    if (after === before) throw new MemoryError(409, "memory did not change");
    return this.#commit({ source: "user", file, before, after });
  }
  #target(file: MemoryBook, id: string, revision: string) {
    const before = this.#read(file);
    const blocks = parseMemory(before);
    const target = blocks.filter(isEntry).find((e) => e.id === id);
    if (!target) throw new MemoryError(404, "no such memory entry");
    if (target.revision !== revision)
      throw new MemoryError(409, "this entry changed since it was read");
    return { before, blocks, target };
  }
  #entry(file: MemoryBook, id: string): StoredEntry {
    const found = parseMemory(this.#read(file))
      .filter(isEntry)
      .find((e) => e.id === id);
    if (!found) throw new MemoryError(409, "memory changed during the update");
    return this.#view(file, found);
  }
  entries(file: MemoryBook): StoredEntry[] {
    return parseMemory(this.read(file))
      .filter(isEntry)
      .map((e) => this.#view(file, e));
  }
  addEntry(file: MemoryBook, text: string, pinned = false) {
    this.#checkText(text);
    this.#recover();
    const before = this.#read(file);
    const eol = eolOf(before);
    const id = ulid();
    const meta = {
      id,
      src: "user",
      at: localDay(this.#now()),
      ...(pinned ? { pin: true as const } : {}),
    };
    const sep = before === "" || before.endsWith("\n") ? "" : eol;
    const change = this.#userCommit(file, before, `${before}${sep}${renderEntry(text, meta, eol)}`);
    return { change, entry: this.#entry(file, id) };
  }
  editEntry(
    file: MemoryBook,
    id: string,
    revision: string,
    patch: { text?: string; pinned?: boolean },
  ) {
    if (patch.text !== undefined) this.#checkText(patch.text);
    this.#recover();
    const { before, blocks, target } = this.#target(file, id, revision);
    const { pin: _pin, ...rest } = target.meta;
    const keepId = target.meta.id === target.id ? target.id : ulid();
    const pinned = patch.pinned ?? Boolean(target.meta.pin);
    const raw = renderEntry(
      patch.text ?? target.text,
      { ...rest, id: keepId, ...(pinned ? { pin: true as const } : {}) },
      eolOf(before),
    );
    const after = serializeMemory(blocks.map((b) => (b === target ? { ...target, raw } : b)));
    return { change: this.#userCommit(file, before, after), entry: this.#entry(file, keepId) };
  }
  deleteEntry(file: MemoryBook, id: string, revision: string) {
    this.#recover();
    const { before, blocks, target } = this.#target(file, id, revision);
    return {
      change: this.#userCommit(file, before, serializeMemory(blocks.filter((b) => b !== target))),
    };
  }
  undo(changeId: string): MemoryChangeRecord & { undoes: string } {
    if (!Id.safeParse(changeId).success) throw new MemoryError(400, "invalid change id");
    this.#recover();
    const history = this.#history(changeId);
    if (history.undone) throw new MemoryError(409, "this change was already undone");
    if (this.#read(history.file as MemoryFile) !== history.after)
      throw new MemoryError(409, `${history.file} has changed since; undo the later changes first`);
    return {
      ...this.#commit({
        ...(history.sessionId ? { sessionId: history.sessionId } : {}),
        source: history.source ?? "agent",
        file: history.file,
        before: history.after,
        after: history.before,
        undoes: changeId,
      }),
      undoes: changeId,
    };
  }
  #commit(history: History): MemoryChangeRecord {
    const changeId = ulid();
    const pending = Pending.safeParse({ changeId, history });
    if (!pending.success) throw new MemoryError(400, "invalid memory change before persistence");
    this.#files.write(".pending.json", JSON.stringify(pending.data));
    this.#recover();
    return {
      changeId,
      ...(history.sessionId ? { sessionId: history.sessionId } : {}),
      source: history.source ?? "agent",
      file: history.file as MemoryFile,
      patch: unifiedDiff(history.before, history.after, { path: history.file }),
    };
  }
  #recover(): void {
    const text = this.#files.text(".pending.json", 256 * 1024);
    if (text === undefined) return;
    let pending: z.infer<typeof Pending>;
    try {
      pending = Pending.parse(JSON.parse(text));
    } catch {
      throw new MemoryError(409, "invalid pending memory change");
    }
    const { changeId, history } = pending;
    const file = history.file as MemoryFile;
    const current = this.#read(file);
    if (current !== history.before && current !== history.after)
      throw new MemoryError(
        409,
        "memory changed during a pending update; resolve the conflict first",
      );
    let undone: History | undefined;
    if (history.undoes) {
      undone = this.#history(history.undoes);
      if (
        undone.file !== history.file ||
        undone.after !== history.before ||
        undone.before !== history.after
      )
        throw new MemoryError(409, "pending undo does not match memory history");
    }
    this.#files.write(`.history/${changeId}.json`, JSON.stringify(history));
    if (current !== history.after) this.#files.write(file, history.after);
    if (history.undoes && undone)
      this.#files.write(
        `.history/${history.undoes}.json`,
        JSON.stringify({ ...undone, undone: true }),
      );
    this.#files.remove(".pending.json");
  }
}
