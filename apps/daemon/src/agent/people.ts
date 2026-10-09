import { createHash } from "node:crypto";
import {
  PEOPLE_MAX,
  PersonApp,
  PersonHandle,
  PersonName,
  PersonNote,
  ULID_PATTERN,
  ulid,
} from "@localdot/protocol";
import { z } from "zod";
import { localDay } from "./memory-entries.ts";
import { PrivateFiles } from "./private-files.ts";

const FILE = "people.json";
const FILE_BYTES = 2 * 1024 * 1024;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TaskId = z.string().regex(ULID_PATTERN);
const Row = z.strictObject({
  id: z.string().regex(ULID_PATTERN),
  name: z.string().min(1).max(100),
  app: z.string().min(1).max(40),
  handle: z.string().max(200).nullable(),
  note: z.string().max(300).nullable(),
  lastAt: Day.nullable(),
  src: z.union([z.literal("user"), z.string().regex(ULID_PATTERN)]),
});
type Row = z.infer<typeof Row>;
const Stored = z.strictObject({ v: z.literal(1), people: z.array(Row).max(PEOPLE_MAX) });

export interface StoredPerson {
  id: string;
  name: string;
  app: string;
  handle: string | null;
  note: string | null;
  lastAt: string | null;
  source: { kind: "task"; sessionId: string } | { kind: "user" };
  revision: string;
}
export interface PersonFields {
  name: string;
  app: string;
  handle?: string | null;
  note?: string | null;
}

export class PeopleError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 500,
    message: string,
  ) {
    super(message);
    this.name = "PeopleError";
  }
}

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const terms = (s: string) => fold(s).match(/[\p{L}\p{N}@+._-]+/gu) ?? [];
const revisionOf = (r: Row) =>
  createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 16);
const view = (r: Row): StoredPerson => ({
  id: r.id,
  name: r.name,
  app: r.app,
  handle: r.handle,
  note: r.note,
  lastAt: r.lastAt,
  source: r.src === "user" ? { kind: "user" } : { kind: "task", sessionId: r.src },
  revision: revisionOf(r),
});
const newest = (a: Row, b: Row) =>
  (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || a.name.localeCompare(b.name);
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PeopleError(400, "invalid person");
  return parsed.data;
}

const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const literal = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

// Whether the user's own words name this person: the whole name, as whole words. Chinese, Japanese
// and Korean don't space their words, so there the whole name anywhere counts.
export function namedIn(texts: readonly string[], name: string): boolean {
  const said = fold(texts.join("\n"));
  const whole = fold(name);
  if (!whole) return false;
  if (UNSPACED.test(whole)) return said.includes(whole);
  return new RegExp(`(?<![\\p{L}\\p{N}])${literal(whole)}(?![\\p{L}\\p{N}])`, "u").test(said);
}

// The people dot reaches for the user: a private file the user can read, edit and delete.
export class PeopleStore {
  readonly #files: PrivateFiles;
  readonly #now: () => Date;
  constructor(home: string, opts: { now?: () => Date } = {}) {
    this.#files = new PrivateFiles(home, "memory");
    this.#now = opts.now ?? (() => new Date());
  }
  #read(): Row[] {
    let text: string | undefined;
    try {
      text = this.#files.text(FILE, FILE_BYTES);
    } catch {
      throw new PeopleError(500, "the people file can't be read");
    }
    if (text === undefined) return [];
    try {
      return Stored.parse(JSON.parse(text)).people;
    } catch {
      throw new PeopleError(500, "the people file is invalid");
    }
  }
  #write(people: Row[]): void {
    if (people.length > PEOPLE_MAX) throw new PeopleError(413, "too many people saved");
    this.#files.write(FILE, `${JSON.stringify({ v: 1, people })}\n`);
  }
  list(): StoredPerson[] {
    return this.#read().sort(newest).map(view);
  }
  find(query: string, limit = 8): StoredPerson[] {
    const wanted = terms(query);
    if (!wanted.length) return [];
    const scored = this.#read().flatMap((r) => {
      const name = fold(r.name);
      const all = fold([r.name, r.app, r.handle ?? "", r.note ?? ""].join(" "));
      if (!wanted.every((term) => all.includes(term))) return [];
      const q = wanted.join(" ");
      const score =
        name === q ? 0 : name.startsWith(q) ? 1 : wanted.every((t) => name.includes(t)) ? 2 : 3;
      return [{ r, score }];
    });
    return scored
      .sort((a, b) => a.score - b.score || newest(a.r, b.r))
      .slice(0, limit)
      .map(({ r }) => view(r));
  }
  // Whether saving would change how the user reaches someone already saved: another handle or note
  // on the same app, the same name on another app, or a new name inside a saved one or holding it
  // (Henry beside Henry Liu), which finding them would mix up.
  redirects(fields: PersonFields): boolean {
    const name = fold(fields.name);
    const people = this.#read();
    const same = people.filter((r) => fold(r.name) === name);
    if (!same.length)
      return people.some((r) => namedIn([r.name], fields.name) || namedIn([fields.name], r.name));
    const onApp = same.find((r) => fold(r.app) === fold(fields.app));
    return (
      !onApp ||
      (fields.handle != null && fields.handle !== onApp.handle) ||
      (fields.note != null && fields.note !== onApp.note)
    );
  }
  // dot reached someone in a task: the same name on the same app is the same person.
  record(sessionId: string, fields: PersonFields): { person: StoredPerson; created: boolean } {
    if (!ULID_PATTERN.test(sessionId)) throw new PeopleError(400, "invalid task");
    const clean = this.#fields(fields);
    const people = this.#read();
    const today = localDay(this.#now());
    const at = people.findIndex(
      (r) => fold(r.name) === fold(clean.name) && fold(r.app) === fold(clean.app),
    );
    const old = people[at];
    if (!old) {
      const added: Row = {
        id: ulid(),
        ...clean,
        handle: clean.handle ?? null,
        note: clean.note ?? null,
        lastAt: today,
        src: sessionId,
      };
      this.#write([...people, added]);
      return { person: view(added), created: true };
    }
    const handle = clean.handle ?? old.handle;
    const note = clean.note ?? old.note;
    const rewrote = handle !== old.handle || note !== old.note;
    const next: Row = {
      ...old,
      handle,
      note,
      lastAt: today,
      ...(rewrote ? { src: sessionId } : {}),
    };
    people[at] = next;
    this.#write(people);
    return { person: view(next), created: false };
  }
  add(fields: PersonFields & { lastAt?: string; sessionId?: string }): StoredPerson {
    const clean = this.#fields(fields);
    const added: Row = {
      id: ulid(),
      ...clean,
      handle: clean.handle ?? null,
      note: clean.note ?? null,
      lastAt: fields.lastAt === undefined ? null : checked(Day, fields.lastAt),
      src: fields.sessionId === undefined ? "user" : checked(TaskId, fields.sessionId),
    };
    this.#write([...this.#read(), added]);
    return view(added);
  }
  edit(id: string, revision: string, patch: Partial<PersonFields>): StoredPerson {
    const people = this.#read();
    const at = this.#at(people, id, revision);
    const old = people[at] as Row;
    const clean = this.#fields({
      name: patch.name ?? old.name,
      app: patch.app ?? old.app,
      handle: patch.handle === undefined ? old.handle : patch.handle,
      note: patch.note === undefined ? old.note : patch.note,
    });
    const next: Row = {
      ...old,
      ...clean,
      handle: clean.handle ?? null,
      note: clean.note ?? null,
      src: "user",
    };
    people[at] = next;
    this.#write(people);
    return view(next);
  }
  remove(id: string, revision: string): void {
    const people = this.#read();
    const at = this.#at(people, id, revision);
    this.#write(people.filter((_, n) => n !== at));
  }
  #at(people: Row[], id: string, revision: string): number {
    const at = people.findIndex((r) => r.id === id);
    const found = people[at];
    if (!found) throw new PeopleError(404, "no such person");
    if (revisionOf(found) !== revision) throw new PeopleError(409, "this person changed since");
    return at;
  }
  #fields(fields: PersonFields) {
    return {
      name: checked(PersonName, fields.name),
      app: checked(PersonApp, fields.app),
      ...(fields.handle == null ? {} : { handle: checked(PersonHandle, fields.handle) }),
      ...(fields.note == null ? {} : { note: checked(PersonNote, fields.note) }),
    };
  }
}
