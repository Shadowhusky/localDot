import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
    expect(change.patch).toBe(
      "--- a/USER.md\n+++ b/USER.md\n@@ -1,2 +1,3 @@\n # About the user\n \n+- Prefers metric units\n",
    );
    expect(readFileSync(join(home, "memory", "USER.md"), "utf8")).toBe(
      "# About the user\n\n- Prefers metric units\n",
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
    expect(memory.read("USER.md")).toBe("# About the user\n\n- A\n");
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
