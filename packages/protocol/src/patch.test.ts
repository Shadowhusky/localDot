import { describe, expect, it } from "vitest";
import { clipPatch, unifiedDiff } from "./patch.ts";

// Applies a unified diff the way `patch` does, so every generated diff is checked by replaying it.
function apply(before: string, patch: string): string {
  const lines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  let at = 0;
  const body = patch.split("\n").slice(2);
  for (let i = 0; i < body.length; i++) {
    const m = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(body[i] ?? "");
    if (!m) continue;
    const oldStart = Number(m[1]);
    const oldCount = Number(m[2]);
    const from = oldCount === 0 ? oldStart : oldStart - 1;
    while (at < from) out.push(lines[at++] as string);
    for (i++; i < body.length && !(body[i] ?? "").startsWith("@@") && body[i] !== ""; i++) {
      const line = body[i] as string;
      let text = `${line.slice(1)}\n`;
      if (body[i + 1] === "\\ No newline at end of file") {
        text = line.slice(1);
        i++;
      }
      if (line.startsWith(" ")) {
        expect(lines[at]).toBe(text);
        out.push(text);
        at++;
      } else if (line.startsWith("-")) {
        expect(lines[at]).toBe(text);
        at++;
      } else out.push(text);
    }
    i--;
  }
  while (at < lines.length) out.push(lines[at++] as string);
  return out.join("");
}

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe("unifiedDiff", () => {
  it("is empty for equal texts", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", { path: "x" })).toBe("");
  });

  it("writes one hunk with context for a changed line", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\nB\nc\n", { path: "notes.md" })).toBe(
      "--- a/notes.md\n+++ b/notes.md\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n",
    );
  });

  it("numbers a hunk that adds to an empty file from line 0", () => {
    expect(unifiedDiff("", "x\n", { path: "new.txt" })).toBe(
      "--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+x\n",
    );
  });

  it("splits far-apart changes into separate hunks", () => {
    const before = `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const after = before.replace("line 2\n", "line two\n").replace("line 27\n", "line 27b\n");
    const patch = unifiedDiff(before, after, { path: "f" });
    expect(patch.match(/^@@/gm)).toHaveLength(2);
    expect(apply(before, patch)).toBe(after);
  });

  it("preserves missing final newlines, including newline-only edits and empty files", () => {
    for (const [before, after] of [
      ["a", "a\n"],
      ["a\n", "a"],
      ["a\nb", "a\nB"],
      ["", "x"],
      ["x", ""],
      ["a\nb\nc", "A\nb\nc"],
      ["\n", ""],
    ]) {
      expect(
        apply(before as string, unifiedDiff(before as string, after as string, { path: "f" })),
      ).toBe(after);
    }
    expect(unifiedDiff("a", "a\n", { path: "f" })).toContain(
      "-a\n\\ No newline at end of file\n+a\n",
    );
  });

  it("falls back to a replayable replacement for a rewrite beyond the edit budget", () => {
    const before = `${Array.from({ length: 800 }, (_, i) => `old ${i}`).join("\n")}\n`;
    const after = Array.from({ length: 800 }, (_, i) => `new ${i}`).join("\n");
    const patch = unifiedDiff(before, after, { path: "large" });
    expect(patch.match(/^@@/gm)).toHaveLength(1);
    expect(apply(before, patch)).toBe(after);
  });

  it("produces patches that replay exactly, for 200 random edits", () => {
    const rand = seeded(7);
    const words = ["alpha", "beta", "gamma", "delta", ""];
    for (let n = 0; n < 200; n++) {
      const a = Array.from(
        { length: Math.floor(rand() * 20) },
        () => words[Math.floor(rand() * 5)],
      );
      const b = a.flatMap((w) => {
        const r = rand();
        if (r < 0.15) return [];
        if (r < 0.3) return [w, words[Math.floor(rand() * 5)] as string];
        if (r < 0.4) return [`${w}!`];
        return [w];
      });
      const before = a.length ? `${a.join("\n")}\n` : "";
      const after = b.length ? `${b.join("\n")}\n` : "";
      expect(apply(before, unifiedDiff(before, after, { path: "r" }))).toBe(after);
    }
  });
});

describe("clipPatch", () => {
  it("cuts a long patch at a line and says so", () => {
    const patch = `${"+x\n".repeat(100)}`;
    const cut = clipPatch(patch, 31);
    expect(cut).toBe(`${"+x\n".repeat(10)}… (diff cut at 31 characters)\n`);
    expect(clipPatch("+a\n", 31)).toBe("+a\n");
  });
});

it("refuses invalid context instead of looping or emitting an incomplete patch", () => {
  for (const context of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => unifiedDiff("before", "after", { path: "file", context })).toThrow(RangeError);
});
