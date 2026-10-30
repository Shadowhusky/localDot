import { describe, expect, it } from "vitest";
import { diffCounts, diffLines, sideBySide } from "./diff.ts";

describe("a patch as numbered lines", () => {
  it("numbers kept, removed and added lines from the hunk and leaves out the file headers", () => {
    const diff = diffLines(
      "--- a/server.ts\n+++ b/server.ts\n@@ -10,3 +10,4 @@\n const port = 3000;\n-listen(port);\n+listen(port, host);\n+log(port);\n done();\n",
    );
    expect(diff?.lines).toEqual([
      { kind: "hunk", text: "@@ -10,3 +10,4 @@" },
      { kind: "same", text: "const port = 3000;", old: 10, new: 10 },
      { kind: "remove", text: "listen(port);", old: 11 },
      { kind: "add", text: "listen(port, host);", new: 11 },
      { kind: "add", text: "log(port);", new: 12 },
      { kind: "same", text: "done();", old: 12, new: 13 },
    ]);
    expect(diffCounts(diff?.lines ?? [])).toEqual({ added: 2, removed: 1 });
  });
  it("numbers a new file's lines from one when its patch has no hunk header", () => {
    expect(diffLines("+Month,Net\n+Dec,12000")?.lines).toEqual([
      { kind: "add", text: "Month,Net", new: 1 },
      { kind: "add", text: "Dec,12000", new: 2 },
    ]);
  });
  it("has nothing to show for a binary or empty patch", () => {
    expect(diffLines(undefined)).toBeNull();
    expect(diffLines("Binary files a/x.png and b/x.png differ")).toBeNull();
  });
  it("faces each removed line with the added line that replaced it", () => {
    const diff = diffLines("@@ -1,3 +1,3 @@\n a\n-b\n-c\n+B\n d")?.lines ?? [];
    const pairs = sideBySide(diff);
    expect(pairs.map((pair) => [pair.hunk ?? pair.left?.text, pair.right?.text])).toEqual([
      ["@@ -1,3 +1,3 @@", undefined],
      ["a", "a"],
      ["b", "B"],
      ["c", undefined],
      ["d", "d"],
    ]);
  });
});
