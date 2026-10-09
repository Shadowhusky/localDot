import { describe, expect, it } from "vitest";
import {
  bootView,
  type MemoryEntryBlock,
  parseMemory,
  renderEntry,
  replaceVisible,
  serializeMemory,
  stripComments,
  tagAppend,
} from "./memory-entries.ts";

const A = "01JXYZ0000000000000000AAAA";
const B = "01JXYZ0000000000000000BBBB";
const C = "01JXYZ0000000000000000CCCC";
const S = "01JXYZ0000000000000000SESS";
const entries = (text: string) =>
  parseMemory(text).filter((b): b is MemoryEntryBlock => b.kind === "entry");

const HAND_WRITTEN = [
  "# About the user\r\n",
  "\r\n",
  "Some prose with a - dash.\r\n",
  "- Prefers metric units\r\n",
  "  and 24-hour time\r\n",
  "* not an entry\r\n",
  "```\n",
  "- inside a fence\n",
  "```\n",
  "- 喜欢靠窗的座位 🙂\n",
  "  - nested detail\n",
  "\n",
  "- last line without newline",
].join("");

describe("memory document model", () => {
  it("round-trips hand-written Markdown byte for byte", () => {
    expect(serializeMemory(parseMemory(HAND_WRITTEN))).toBe(HAND_WRITTEN);
    expect(entries(HAND_WRITTEN).map((e) => e.text)).toEqual([
      "Prefers metric units\nand 24-hour time",
      "喜欢靠窗的座位 🙂\n- nested detail",
      "last line without newline",
    ]);
    expect(entries(HAND_WRITTEN).every((e) => /^x[0-9a-f]{16}$/.test(e.id))).toBe(true);
  });

  it("keeps every other byte when one entry changes", () => {
    const blocks = parseMemory(HAND_WRITTEN);
    const target = entries(HAND_WRITTEN)[1] as MemoryEntryBlock;
    const replacement = renderEntry("Prefers aisle seats", { id: A }, "\n");
    const out = serializeMemory(
      blocks.map((b) => (b.raw === target.raw ? { ...b, raw: replacement } : b)),
    );
    expect(out.replace(replacement, target.raw)).toBe(HAND_WRITTEN);
  });

  it("reads trailing metadata and ignores invalid fields", () => {
    const text = `- Likes tea <!-- ld:id=${A} src=${S} at=2026-09-03 pin=1 -->\n- Bad <!-- ld:id=nope src=evil at=yesterday pin=2 -->\n`;
    const [tea, bad] = entries(text);
    expect(tea).toMatchObject({
      id: A,
      text: "Likes tea",
      meta: { id: A, src: S, at: "2026-09-03", pin: true },
    });
    expect(bad?.meta).toEqual({});
    expect(bad?.text).toBe("Bad");
    expect(bad?.id).toMatch(/^x[0-9a-f]{16}$/);
  });

  it("gives a copied metadata id to the first entry only, with a stable derived id for the copy", () => {
    const line = `- Same <!-- ld:id=${A} -->\n`;
    const [first, second] = entries(line + line);
    expect(first?.id).toBe(A);
    expect(second?.id).toMatch(/^x[0-9a-f]{16}$/);
    expect(entries(line + line)[1]?.id).toBe(second?.id);
    expect(first?.revision).toBe(second?.revision);
  });

  it("does not treat '- ' lines inside a code fence as entries", () => {
    expect(entries("```\n- not me\n```\n~~~\n- nor me\n~~~\n- me\n").map((e) => e.text)).toEqual([
      "me",
    ]);
  });

  it("renders entries that parse back to the same text and metadata", () => {
    const raw = renderEntry(
      "- Prefers window seats\non long flights",
      { id: A, src: "user", at: "2026-10-08", pin: true },
      "\r\n",
    );
    expect(raw).toBe(
      `- Prefers window seats\r\n  on long flights <!-- ld:id=${A} src=user at=2026-10-08 pin=1 -->\r\n`,
    );
    expect(entries(raw)[0]).toMatchObject({
      id: A,
      text: "Prefers window seats\non long flights",
      meta: { id: A, src: "user", at: "2026-10-08", pin: true },
    });
  });

  it("replaces text seen without metadata and keeps neighbouring metadata", () => {
    const text = `# M\n\n- Office is in Lyon <!-- ld:id=${A} src=${S} at=2026-09-01 -->\n- Car renews in March <!-- ld:id=${B} at=2026-09-02 -->\n`;
    expect(replaceVisible(text, "Lyon", "Paris")).toBe(text.replace("Lyon", "Paris"));
    expect(
      replaceVisible(text, "- Office is in Lyon\n- Car renews in March", "- Office and car notes"),
    ).toBe(`# M\n\n- Office and car notes <!-- ld:id=${B} at=2026-09-02 -->\n`);
    expect(replaceVisible(text, "Berlin", "x")).toBe("missing");
    expect(replaceVisible(`${text}- Office is in Lyon\n`, "Office is in Lyon", "x")).toBe(
      "ambiguous",
    );
  });

  it("tags appended bullets with a fresh id, the task and the day", () => {
    const ids = [A, B];
    let n = 0;
    const next = () => ids[n++] as string;
    expect(
      tagAppend("## Travel\n- Likes window seats\n- Hates red-eyes", S, "2026-10-08", "\n", next),
    ).toBe(
      `## Travel\n- Likes window seats <!-- ld:id=${A} src=${S} at=2026-10-08 -->\n- Hates red-eyes <!-- ld:id=${B} src=${S} at=2026-10-08 -->\n`,
    );
    expect(tagAppend("Prefers tea", S, "2026-10-08", "\n", () => C)).toBe(
      `- Prefers tea <!-- ld:id=${C} src=${S} at=2026-10-08 -->\n`,
    );
    expect(tagAppend("## Only a heading", S, "2026-10-08", "\n", () => C)).toBe(
      "## Only a heading\n",
    );
  });

  it("strips comments so agent text cannot forge metadata", () => {
    expect(stripComments(`Likes tea <!-- ld:id=${A} pin=1 --> ok <!-- x`)).toBe("Likes tea  ok  x");
  });

  it("puts pinned entries first, strips metadata and drops the oldest unpinned entries over budget", () => {
    const text = `# Notes\n\n- Old fact <!-- ld:id=${A} at=2026-01-01 -->\n- Pinned fact <!-- ld:id=${B} at=2025-01-01 pin=1 -->\n- Undated fact\n- New fact <!-- ld:id=${C} at=2026-10-01 -->\n`;
    expect(bootView(text, 20_000)).toBe(
      "## Always remember\n- Pinned fact\n\n# Notes\n\n- Old fact\n- Undated fact\n- New fact\n",
    );
    const budget = "## Always remember\n- Pinned fact\n\n# Notes\n\n- Old fact\n- New fact\n"
      .length;
    expect(bootView(text, budget)).toBe(
      "## Always remember\n- Pinned fact\n\n# Notes\n\n- Old fact\n- New fact\n",
    );
    expect(bootView("# Notes\n\n- A\n", 20_000)).toBe("# Notes\n\n- A\n");
  });
});
