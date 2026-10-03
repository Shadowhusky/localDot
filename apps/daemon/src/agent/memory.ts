import { ULID_PATTERN, ulid, unifiedDiff } from "@localdot/protocol";
import { z } from "zod";
import { PrivateFiles } from "./private-files.ts";
export type MemoryFile = "USER.md" | "MEMORY.md";
export const MEMORY_MAX_CHARS = 20_000;
const File = z.enum(["USER.md", "MEMORY.md"]);
const Text = z
  .string()
  .max(MEMORY_MAX_CHARS)
  .refine((s) => s.isWellFormed() && !s.includes("\0"));
const Id = z.string().regex(ULID_PATTERN);
const History = z.strictObject({
  sessionId: Id,
  file: File,
  before: Text,
  after: Text,
  undone: z.boolean().optional(),
  undoes: Id.optional(),
});
type History = z.infer<typeof History>;
const Pending = z.strictObject({ changeId: Id, history: History });
const TEMPLATES: Record<MemoryFile, string> = {
  "USER.md": "# About the user\n\n",
  "MEMORY.md": "# Things worth remembering\n\n",
};
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
  sessionId: string;
  file: MemoryFile;
  patch: string;
}
export class MemoryStore {
  readonly #files: PrivateFiles;
  constructor(home: string) {
    this.#files = new PrivateFiles(home, "memory");
    this.#files.directory(".history");
    this.#recover();
  }
  #read(file: MemoryFile): string {
    try {
      const text = this.#files.text(file, 80_000) ?? TEMPLATES[file];
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
    file: MemoryFile,
    op: "append" | "replace",
    text: string,
    oldText?: string,
  ): MemoryChangeRecord {
    if (
      !Id.safeParse(sessionId).success ||
      !File.safeParse(file).success ||
      !Text.safeParse(text).success ||
      (op !== "append" && op !== "replace")
    )
      throw new MemoryError(400, "invalid memory change");
    this.#recover();
    const before = this.#read(file);
    let after: string;
    if (op === "append") {
      if (!text.trim()) throw new MemoryError(400, "nothing to remember");
      after = `${before}${before.endsWith("\n") || !before ? "" : "\n"}${text.trimEnd()}\n`;
    } else {
      if (!oldText || !Text.safeParse(oldText).success)
        throw new MemoryError(400, "replace needs nonempty valid old_text within the memory limit");
      const at = before.indexOf(oldText);
      if (at < 0) throw new MemoryError(409, `old_text is not in ${file}`);
      if (before.indexOf(oldText, at + 1) >= 0)
        throw new MemoryError(409, `old_text occurs more than once in ${file}`);
      after = before.slice(0, at) + text + before.slice(at + oldText.length);
    }
    if (after.length > MEMORY_MAX_CHARS)
      throw new MemoryError(
        409,
        `${file} would pass ${MEMORY_MAX_CHARS} characters; replace older lines instead`,
      );
    if (after === before) throw new MemoryError(409, "memory did not change");
    return this.#commit({ sessionId, file, before, after });
  }
  undo(changeId: string): MemoryChangeRecord & { undoes: string } {
    if (!Id.safeParse(changeId).success) throw new MemoryError(400, "invalid change id");
    this.#recover();
    const history = this.#history(changeId);
    if (history.undone) throw new MemoryError(409, "this change was already undone");
    if (this.#read(history.file) !== history.after)
      throw new MemoryError(409, `${history.file} has changed since; undo the later changes first`);
    return {
      ...this.#commit({
        sessionId: history.sessionId,
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
      sessionId: history.sessionId,
      file: history.file,
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
    const current = this.#read(history.file);
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
    if (current !== history.after) this.#files.write(history.file, history.after);
    if (history.undoes && undone)
      this.#files.write(
        `.history/${history.undoes}.json`,
        JSON.stringify({ ...undone, undone: true }),
      );
    this.#files.remove(".pending.json");
  }
}
