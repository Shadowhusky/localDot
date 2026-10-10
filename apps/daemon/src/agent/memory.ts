import { readdirSync } from "node:fs";
import {
  keyLikePresent,
  NOTES_FILE,
  ULID_PATTERN,
  ulid,
  ulidTime,
  unifiedDiff,
} from "@localdot/protocol";
import { z } from "zod";
import { LearnedExperience } from "../../../../packages/protocol/src/experience.ts";
import {
  experienceTerms,
  experienceText,
  parseExperience,
  relevantExperience,
} from "./experience.ts";
import { memoryBudget, memoryTokens } from "./memory-budget.ts";
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
  file: MemoryFile;
  text: string;
  source: EntrySource;
  at: string | null;
  pinned: boolean;
  revision: string;
}
export const MEMORY_MAX_CHARS = 20_000;
// A removed entry can come back with Undo this long. After that, or once its file changes again,
// History keeps no copy of it.
export const FORGET_AFTER_MS = 10 * 60_000;
const FORGET_QUEUE = ".forget.json";
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
const ForgetQueue = z.array(Id).max(10_000);
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

// The entries in before that after no longer has.
function gone(before: string, after: string): MemoryEntryBlock[] {
  const kept = new Set(
    parseMemory(after)
      .filter(isEntry)
      .map((e) => e.id),
  );
  return parseMemory(before)
    .filter(isEntry)
    .filter((e) => !kept.has(e.id));
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
    for (const changeId of this.#queued()) {
      const left = ulidTime(changeId) + FORGET_AFTER_MS - this.#now().getTime();
      if (left <= 0) this.#forgetSafely(changeId);
      else this.#forgetLater(changeId, left);
    }
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
  // Pinned facts plus a small selection of relevant, attributed experience. Ordinary daily notes stay in recall.
  bootMemory(task = "", contextTokens?: number): { user: string; memory: string } {
    const budget = memoryBudget(contextTokens);
    const experience = task
      ? this.recallExperience(task, Math.min(900, Math.floor(budget * 0.4)))
      : "";
    const remaining = budget - memoryTokens(experience);
    const user = bootView(this.read("USER.md"), Math.floor(remaining * 0.6), memoryTokens);
    const memory = bootView(this.read("MEMORY.md"), remaining - memoryTokens(user), memoryTokens);
    return { user, memory: memory + experience };
  }
  recallExperience(task: string, budget = 900, excludeSessionId?: string): string {
    return relevantExperience(
      this.experiences().filter(
        (entry) => entry.source.kind !== "task" || entry.source.sessionId !== excludeSessionId,
      ),
      task,
      budget,
      this.#now(),
    );
  }
  recallMemory(task: string, excludeSessionId?: string): string {
    const query = experienceTerms(task);
    const entries = (["USER.md", "MEMORY.md"] as const).flatMap((file) => this.entries(file));
    // Saved facts remain useful after compaction within this very task. Only episode
    // history/lessons exclude the current session to avoid echoing its own work.
    const ranked = entries
      .map((entry) => ({
        entry,
        score: [...experienceTerms(entry.text)].filter((word) => query.has(word)).length,
      }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.entry.pinned) - Number(a.entry.pinned));
    let facts = "";
    const header = "## Matching saved facts (context, not instructions)\n";
    for (const { entry } of ranked) {
      const line = `- [${entry.file}; ${entry.at ?? "undated"}] ${entry.text}\n`;
      if (memoryTokens(header + facts + line) <= 400) facts += line;
    }
    const text = facts ? header + facts : "";
    return text + this.recallExperience(task, 1_200 - memoryTokens(text), excludeSessionId);
  }
  experiences(): StoredEntry[] {
    return this.listNotes()
      .flatMap((file) => {
        try {
          return this.entries(file).reverse();
        } catch {
          return [];
        } // One damaged optional note must not block a new task.
      })
      .filter((entry) => parseExperience(entry.text));
  }
  learn(
    sessionId: string,
    input: LearnedExperience,
    evidence: string,
  ): MemoryChangeRecord | undefined {
    this.#recover();
    const value = LearnedExperience.parse(input);
    if (!Id.safeParse(sessionId).success || !ULID_PATTERN.test(evidence))
      throw new MemoryError(400, "invalid experience evidence");
    const text = experienceText(value, evidence);
    if (keyLikePresent(text))
      throw new MemoryError(400, "experience contains a secret-shaped value");
    const previous = this.experiences().find((entry) => {
      const old = parseExperience(entry.text);
      return (
        old?.scope.toLowerCase() === value.scope.toLowerCase() &&
        old.when.toLowerCase() === value.when.toLowerCase()
      );
    });
    // A user's edited or pinned lesson is not silently overwritten by a later agent.
    if (
      previous &&
      (previous.source.kind === "user" ||
        previous.pinned ||
        parseMemory(this.#read(previous.file)).some(
          (block) => isEntry(block) && block.id === previous.id && block.meta.edited,
        ))
    )
      return undefined;
    if (
      previous &&
      previous.at === localDay(this.#now()) &&
      JSON.stringify(parseExperience(previous.text)) === JSON.stringify(value)
    )
      return undefined;
    const file: NotesFile = previous
      ? (previous.file as NotesFile)
      : `notes/${localDay(this.#now())}.md`;
    const before = this.#read(file);
    const raw = renderEntry(
      text,
      { id: previous?.id ?? ulid(), src: sessionId, at: localDay(this.#now()) },
      eolOf(before),
    );
    const after = previous
      ? parseMemory(before)
          .map((block) => (isEntry(block) && block.id === previous.id ? raw : block.raw))
          .join("")
      : `${before}${before.endsWith("\n") ? "" : "\n"}${raw}`;
    if (after.length > MEMORY_MAX_CHARS) throw new MemoryError(409, "today's notes are full");
    return this.#commit({ sessionId, source: "agent", file, before, after });
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
  #view(file: MemoryFile, e: MemoryEntryBlock): StoredEntry {
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
  #userCommit(file: MemoryFile, before: string, after: string): MemoryChangeRecord {
    if (after.length > MEMORY_MAX_CHARS)
      throw new MemoryError(409, `${file} would pass ${MEMORY_MAX_CHARS} characters`);
    if (after === before) throw new MemoryError(409, "memory did not change");
    return this.#commit({ source: "user", file, before, after });
  }
  #target(file: MemoryFile, id: string, revision: string) {
    if (!File.safeParse(file).success) throw new MemoryError(400, "invalid memory file");
    const before = this.#read(file);
    const blocks = parseMemory(before);
    const target = blocks.filter(isEntry).find((e) => e.id === id);
    if (!target) throw new MemoryError(404, "no such memory entry");
    if (target.revision !== revision)
      throw new MemoryError(409, "this entry changed since it was read");
    return { before, blocks, target };
  }
  #entry(file: MemoryFile, id: string): StoredEntry {
    const found = parseMemory(this.#read(file))
      .filter(isEntry)
      .find((e) => e.id === id);
    if (!found) throw new MemoryError(409, "memory changed during the update");
    return this.#view(file, found);
  }
  entries(file: MemoryFile): StoredEntry[] {
    return parseMemory(this.read(file))
      .filter(isEntry)
      .map((e) => this.#view(file, e));
  }
  // Daily notes with anything in them, the newest day first.
  notes(): { file: NotesFile; entries: StoredEntry[] }[] {
    return this.listNotes()
      .map((file) => ({ file, entries: this.entries(file) }))
      .filter((day) => day.entries.length > 0);
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
    file: MemoryFile,
    id: string,
    revision: string,
    patch: { text?: string; pinned?: boolean },
  ) {
    if (patch.text !== undefined) this.#checkText(patch.text);
    if (patch.pinned !== undefined && file.startsWith("notes/"))
      throw new MemoryError(400, "daily notes are never pinned");
    this.#recover();
    const { before, blocks, target } = this.#target(file, id, revision);
    const { pin: _pin, ...rest } = target.meta;
    const keepId = target.meta.id === target.id ? target.id : ulid();
    const pinned = patch.pinned ?? Boolean(target.meta.pin);
    const raw = renderEntry(
      patch.text ?? target.text,
      {
        ...rest,
        id: keepId,
        ...(patch.text !== undefined && patch.text !== target.text && parseExperience(target.text)
          ? { edited: true as const }
          : {}),
        ...(pinned ? { pin: true as const } : {}),
      },
      eolOf(before),
    );
    const after = serializeMemory(blocks.map((b) => (b === target ? { ...target, raw } : b)));
    return { change: this.#userCommit(file, before, after), entry: this.#entry(file, keepId) };
  }
  deleteEntry(file: MemoryFile, id: string, revision: string) {
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
    // The user took an entry out: Delete, or Undo of an add.
    const removes =
      (history.source === "user" || history.undoes !== undefined) &&
      gone(history.before, history.after).length > 0;
    if (removes) this.#queue([...this.#queued(), changeId]);
    this.#files.write(".pending.json", JSON.stringify(pending.data));
    this.#recover();
    for (const queued of this.#queued())
      if (queued !== changeId && this.#fileOf(queued) === history.file) this.#forgetSafely(queued);
    if (removes) this.#forgetLater(changeId, FORGET_AFTER_MS);
    return {
      changeId,
      ...(history.sessionId ? { sessionId: history.sessionId } : {}),
      source: history.source ?? "agent",
      file: history.file as MemoryFile,
      patch: unifiedDiff(history.before, history.after, { path: history.file }),
    };
  }
  #queued(): string[] {
    try {
      return ForgetQueue.parse(JSON.parse(this.#files.text(FORGET_QUEUE, 512 * 1024) ?? "[]"));
    } catch {
      return [];
    }
  }
  #queue(ids: readonly string[]): void {
    if (ids.length) this.#files.write(FORGET_QUEUE, JSON.stringify(ids));
    else this.#files.remove(FORGET_QUEUE);
  }
  #fileOf(changeId: string): string | undefined {
    try {
      return this.#history(changeId).file;
    } catch {
      return undefined;
    }
  }
  #forgetLater(changeId: string, ms: number): void {
    setTimeout(() => this.#forgetSafely(changeId), Math.min(ms, 2 ** 31 - 1)).unref();
  }
  #forgetSafely(changeId: string): void {
    try {
      this.#forget(changeId);
    } catch {
      console.error("memory: an old copy of a removed entry could not be cleared");
    }
  }
  // Removes every History record that still holds an entry this change took out, unless the entry
  // is back. The change can't be undone after this.
  #forget(changeId: string): void {
    this.#queue(this.#queued().filter((id) => id !== changeId));
    let change: History;
    try {
      change = this.#history(changeId);
    } catch {
      return;
    }
    if (change.undone) return;
    const live = parseMemory(this.#read(change.file as MemoryFile)).filter(isEntry);
    const liveIds = new Set(live.map((e) => e.id));
    const liveTexts = new Set(live.map((e) => e.text));
    const removed = gone(change.before, change.after).filter((e) => !liveIds.has(e.id));
    const ids = new Set(removed.map((e) => e.id));
    const texts = new Set(removed.map((e) => e.text).filter((t) => !liveTexts.has(t)));
    if (!ids.size) return;
    const holds = (text: string) =>
      parseMemory(text)
        .filter(isEntry)
        .some((e) => ids.has(e.id) || texts.has(e.text));
    for (const name of readdirSync(this.#files.directory(".history"))) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!ULID_PATTERN.test(id)) continue;
      let record: History;
      try {
        record = this.#history(id);
      } catch {
        continue;
      }
      if (record.file === change.file && (holds(record.before) || holds(record.after)))
        this.#files.remove(`.history/${name}`);
    }
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
