import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryError, MemoryStore } from "./memory.ts";

const ownedHomes: string[] = [];
afterEach(() => {
  for (const home of ownedHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function ownedTemp(prefix: string): string {
  const home = mkdtempSync(prefix);
  ownedHomes.push(home);
  return home;
}

const SESSION = "01JXYZ0000000000000000SESS";

function store() {
  const home = ownedTemp(join(tmpdir(), "local dot's memory-"));
  return { home, memory: new MemoryStore(home) };
}

describe("MemoryStore", () => {
  it("starts from the templates and appends with a diff", () => {
    const { home, memory } = store();
    expect(memory.readBoth()).toEqual({
      user: "# About the user\n\n",
      memory: "# Things worth remembering\n\n",
    });
    const change = memory.apply(SESSION, "USER.md", "append", "- Prefers metric units");
    expect(change.patch).toMatch(
      /^--- a\/USER.md\n\+\+\+ b\/USER.md\n@@ -1,2 \+1,3 @@\n # About the user\n \n\+- Prefers metric units <!-- ld:id=[0-9A-Z]{26} src=01JXYZ0000000000000000SESS at=\d{4}-\d{2}-\d{2} -->\n$/,
    );
    expect(readFileSync(join(home, "memory", "USER.md"), "utf8")).toMatch(
      /^# About the user\n\n- Prefers metric units <!-- ld:id=[0-9A-Z]{26} src=01JXYZ0000000000000000SESS at=\d{4}-\d{2}-\d{2} -->\n$/,
    );
    expect(statSync(join(home, "memory", "USER.md")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "memory")).mode & 0o777).toBe(0o700);
  });

  it("replaces text that occurs exactly once", () => {
    const { memory } = store();
    memory.apply(SESSION, "MEMORY.md", "append", "- Office is in Lyon");
    memory.apply(SESSION, "MEMORY.md", "replace", "- Office is in Paris", "- Office is in Lyon");
    expect(memory.read("MEMORY.md")).toContain("Paris");
    expect(() => memory.apply(SESSION, "MEMORY.md", "replace", "x", "Berlin")).toThrow(MemoryError);
    expect(() => memory.apply(SESSION, "MEMORY.md", "replace", "x")).toThrow(/old_text/);
  });

  it("undoes a change while it is the file's latest, and only once", () => {
    const { memory } = store();
    const first = memory.apply(SESSION, "USER.md", "append", "- A");
    const second = memory.apply(SESSION, "USER.md", "append", "- B");
    expect(() => memory.undo(first.changeId)).toThrow(/changed since/);
    const undone = memory.undo(second.changeId);
    expect(undone.undoes).toBe(second.changeId);
    expect(undone.sessionId).toBe(SESSION);
    expect(undone.patch).toContain("-- B");
    expect(memory.read("USER.md")).toMatch(/^# About the user\n\n- A <!-- ld:[^>]+-->\n$/);
    expect(() => memory.undo(second.changeId)).toThrow(/already undone/);
    expect(() => memory.undo("../../x")).toThrow(/invalid/);
  });

  it("refuses to grow a file past its limit", () => {
    const { memory } = store();
    expect(() => memory.apply(SESSION, "MEMORY.md", "append", "x".repeat(20_000))).toThrow(
      /pass 20000/,
    );
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing value");
  return value;
}
function statusOf(work: () => unknown): number | undefined {
  try {
    work();
  } catch (error) {
    return error instanceof MemoryError ? error.status : -1;
  }
  return undefined;
}
const fakeKey = () => `sk-ant-api03-${"a".repeat(95)}`;

describe("MemoryStore entries", () => {
  it("adds and edits as the user, and Undo restores the exact bytes", () => {
    const { home, memory } = store();
    const added = memory.addEntry("MEMORY.md", "Car insurance renews in September");
    expect(added.entry).toMatchObject({
      file: "MEMORY.md",
      text: "Car insurance renews in September",
      source: { kind: "user" },
      pinned: false,
    });
    expect(added.change).toMatchObject({ source: "user", file: "MEMORY.md" });
    expect(added.change.sessionId).toBeUndefined();
    const history = JSON.parse(
      readFileSync(join(home, "memory", ".history", `${added.change.changeId}.json`), "utf8"),
    );
    expect(history).toMatchObject({ source: "user", file: "MEMORY.md" });
    expect(history.sessionId).toBeUndefined();
    const before = memory.read("MEMORY.md");
    const edited = memory.editEntry("MEMORY.md", added.entry.id, added.entry.revision, {
      text: "Car insurance renews on 3 September",
    });
    expect(edited.entry.id).toBe(added.entry.id);
    expect(memory.read("MEMORY.md")).toContain("Car insurance renews on 3 September");
    memory.undo(edited.change.changeId);
    expect(memory.read("MEMORY.md")).toBe(before);
  });

  it("deletes a pinned entry and Undo brings it back byte for byte", () => {
    const { memory } = store();
    const { entry } = memory.addEntry("USER.md", "Allergic to penicillin", true);
    expect(entry.pinned).toBe(true);
    const before = memory.read("USER.md");
    const removed = memory.deleteEntry("USER.md", entry.id, entry.revision);
    expect(memory.entries("USER.md")).toEqual([]);
    expect(memory.read("USER.md")).not.toContain("penicillin");
    memory.undo(removed.change.changeId);
    expect(memory.read("USER.md")).toBe(before);
    expect(memory.entries("USER.md")[0]).toMatchObject({ id: entry.id, pinned: true });
  });

  it("refuses a stale revision with 409 and an unknown id with 404", () => {
    const { memory } = store();
    const { entry } = memory.addEntry("USER.md", "Lives in Lisbon");
    memory.editEntry("USER.md", entry.id, entry.revision, { pinned: true });
    expect(
      statusOf(() => memory.editEntry("USER.md", entry.id, entry.revision, { text: "x" })),
    ).toBe(409);
    expect(
      statusOf(() => memory.deleteEntry("USER.md", "01JXYZ0000000000000000ZZZZ", "0".repeat(16))),
    ).toBe(404);
  });

  it("changes only the edited entry's bytes in a hand-written file", () => {
    const { home, memory } = store();
    const hand =
      "# About the user\r\n\r\n- Prefers metric units\r\n* not an entry\r\n```\n- fenced\n```\n- Likes tea\n";
    writeFileSync(join(home, "memory", "USER.md"), hand, { mode: 0o600 });
    const tea = required(memory.entries("USER.md").find((e) => e.text === "Likes tea"));
    memory.editEntry("USER.md", tea.id, tea.revision, { text: "Likes green tea" });
    const after = memory.read("USER.md");
    expect(
      after.startsWith(
        "# About the user\r\n\r\n- Prefers metric units\r\n* not an entry\r\n```\n- fenced\n```\n",
      ),
    ).toBe(true);
    // The file's first line ends in CRLF, so the re-rendered entry uses CRLF too.
    expect(after).toMatch(/^[\s\S]*\n- Likes green tea <!-- ld:id=[0-9A-Z]{26} -->\r?\n$/);
  });

  it("refuses key-shaped, comment-like and empty fact text", () => {
    const { memory } = store();
    for (const text of [`My key is ${fakeKey()}`, "a <!-- b", "   ", "x".repeat(1001)])
      expect(statusOf(() => memory.addEntry("MEMORY.md", text))).toBe(400);
  });

  it("still reads History written before entries existed", () => {
    const { home, memory } = store();
    const legacy = memory.apply(SESSION, "USER.md", "append", "- A");
    const file = join(home, "memory", ".history", `${legacy.changeId}.json`);
    const { source: _source, ...old } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
    expect(memory.undo(legacy.changeId)).toMatchObject({ sessionId: SESSION, source: "agent" });
  });
});

describe("MemoryStore agent writes", () => {
  it("tags agent appends with the task and the day and strips forged metadata", () => {
    const { memory } = store();
    memory.apply(
      SESSION,
      "USER.md",
      "append",
      "- Likes tea <!-- ld:id=01JXYZ0000000000000000AAAA src=user pin=1 -->",
    );
    const [tea] = memory.entries("USER.md");
    expect(tea).toMatchObject({
      text: "Likes tea",
      source: { kind: "task", sessionId: SESSION },
      pinned: false,
    });
    expect(tea?.id).not.toBe("01JXYZ0000000000000000AAAA");
  });

  it("replaces text copied from the boot view and keeps neighbouring metadata", () => {
    const { memory } = store();
    memory.apply(SESSION, "MEMORY.md", "append", "- Office is in Lyon\n- Car renews in March");
    const [office, car] = memory.entries("MEMORY.md");
    const boot = memory.bootMemory().memory;
    expect(boot).toContain("- Office is in Lyon\n- Car renews in March\n");
    expect(boot).not.toContain("<!--");
    memory.apply(SESSION, "MEMORY.md", "replace", "- Office is in Paris", "- Office is in Lyon");
    const after = memory.entries("MEMORY.md");
    expect(after.map((e) => [e.id, e.text])).toEqual([
      [office?.id, "Office is in Paris"],
      [car?.id, "Car renews in March"],
    ]);
    expect(() => memory.apply(SESSION, "MEMORY.md", "replace", "x", "Berlin")).toThrow(
      /not in MEMORY.md/,
    );
  });

  it("re-stamps a fact dot rewrote with the task, keeping its id and pin", () => {
    const { memory } = store();
    const { entry } = memory.addEntry("USER.md", "Lives in Lisbon", true);
    memory.addEntry("USER.md", "Prefers metric units");
    memory.apply(SESSION, "USER.md", "replace", "Lives in Porto", "Lives in Lisbon");
    const [porto, metric] = memory.entries("USER.md");
    expect(porto).toMatchObject({
      id: entry.id,
      text: "Lives in Porto",
      pinned: true,
      source: { kind: "task", sessionId: SESSION },
    });
    expect(metric?.source).toEqual({ kind: "user" });
  });

  it("serves boot memory without metadata, pinned entries first", () => {
    const { memory } = store();
    memory.apply(SESSION, "USER.md", "append", "- Prefers metric units");
    memory.addEntry("USER.md", "Allergic to penicillin", true);
    expect(memory.bootMemory().user).toBe(
      "## Always remember\n- Allergic to penicillin\n\n# About the user\n\n- Prefers metric units\n",
    );
  });
});

describe("daily notes", () => {
  const day = new Date(2026, 9, 8, 9, 30);
  function noteStore() {
    const home = ownedTemp(join(tmpdir(), "local dot's notes-"));
    return { home, memory: new MemoryStore(home, { now: () => day }) };
  }
  it("appends to today's file, never boots it and can be undone", () => {
    const { home, memory } = noteStore();
    const change = memory.appendNote(SESSION, "Called the insurer; quote is 412 a year");
    expect(change).toMatchObject({
      file: "notes/2026-10-08.md",
      sessionId: SESSION,
      source: "agent",
    });
    const text = readFileSync(join(home, "memory", "notes", "2026-10-08.md"), "utf8");
    expect(text).toMatch(
      /^# Notes · 2026-10-08\n\n- Called the insurer; quote is 412 a year <!-- ld:id=[0-9A-Z]{26} src=01JXYZ0000000000000000SESS at=2026-10-08 -->\n$/,
    );
    expect(memory.listNotes()).toEqual(["notes/2026-10-08.md"]);
    expect(JSON.stringify(memory.bootMemory())).not.toContain("insurer");
    memory.undo(change.changeId);
    expect(memory.read("notes/2026-10-08.md")).toBe("# Notes · 2026-10-08\n\n");
  });
  it("refuses key-shaped notes and a full day", () => {
    const { home, memory } = noteStore();
    expect(statusOf(() => memory.appendNote(SESSION, `key ${fakeKey()}`))).toBe(400);
    // keyLikePresent treats any text over 8,000 characters as key-shaped, so fill the day on disk
    // (19,973 characters: valid on its own, full once one tagged bullet is added).
    writeFileSync(
      join(home, "memory", "notes", "2026-10-08.md"),
      `# Notes · 2026-10-08\n\n${"x".repeat(19_950)}\n`,
      { mode: 0o600 },
    );
    expect(() => memory.appendNote(SESSION, "One more fact")).toThrow(/today's notes are full/);
  });
  it("refuses a notes path that is not a dated file", () => {
    const { memory } = noteStore();
    for (const file of ["notes/../USER.md", "notes/x.md"])
      expect(statusOf(() => memory.read(file as "notes/x.md"))).toBe(400);
  });
});
