import { describe, expect, it } from "vitest";
import { boundedJson, tableExcerpt, textExcerpt } from "./excerpt.ts";

const bytes = (s: string) => Buffer.from(s);
describe("text and table excerpts", () => {
  it("keeps the first 40 lines and says when there were more", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const preview = textExcerpt("notes.md", bytes(text), Buffer.byteLength(text));
    expect(preview).toMatchObject({ kind: "text", format: "markdown", truncated: true });
    expect(preview.kind === "text" && preview.lines).toHaveLength(40);
  });
  it("drops a character cut by the read boundary instead of calling the file binary", () => {
    const text = `${"a".repeat(9)}保`;
    const head = bytes(text).subarray(0, 10);
    expect(textExcerpt("a.txt", head, Buffer.byteLength(text))).toMatchObject({
      kind: "text",
      truncated: true,
    });
  });
  it("calls NUL bytes and invalid UTF-8 binary", () => {
    expect(textExcerpt("a.txt", Buffer.from([0x61, 0x00, 0x62]), 3)).toEqual({
      kind: "none",
      reason: "binary",
    });
    expect(tableExcerpt("a.csv", Buffer.from([0xff, 0xfe, 0x41]), 3)).toEqual({
      kind: "none",
      reason: "binary",
    });
  });
  it("masks key-shaped text and shows hidden and direction-changing characters as marks", () => {
    const key = `sk-proj-${"A".repeat(40)}`;
    const text = `token=${key}\nsafe\u202Etxt.exe\u0007`;
    const preview = textExcerpt("a.txt", bytes(text), Buffer.byteLength(text));
    expect(JSON.stringify(preview)).not.toContain(key);
    expect(preview.kind === "text" && preview.lines).toEqual([
      "token=••••",
      "safe\uFFFDtxt.exe\uFFFD",
    ]);
  });
  it("cuts long lines without splitting an emoji", () => {
    const text = `${"a".repeat(238)}😀😀`;
    const preview = textExcerpt("a.txt", bytes(text), Buffer.byteLength(text));
    const line = preview.kind === "text" ? (preview.lines[0] as string) : "";
    expect(line.length).toBeLessThanOrEqual(240);
    expect(line.endsWith("…")).toBe(true);
    expect(line.isWellFormed()).toBe(true);
  });
  it("parses quoted cells, doubled quotes, line breaks inside quotes and CRLF", () => {
    const csv = 'a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\r\n';
    expect(tableExcerpt("a.csv", bytes(csv), Buffer.byteLength(csv))).toEqual({
      kind: "table",
      rows: [
        ["a", "b"],
        ["x, y", 'say "hi"'],
        ["two\nlines", "z"],
      ],
      truncated: false,
    });
  });
  it("splits tab-separated files on tabs and caps columns at 12", () => {
    const tsv = `${Array.from({ length: 20 }, (_, i) => `c${i}`).join("\t")}\n`;
    const preview = tableExcerpt("a.tsv", bytes(tsv), Buffer.byteLength(tsv));
    expect(preview.kind === "table" && preview.rows[0]).toHaveLength(12);
    expect(preview.kind === "table" && preview.truncated).toBe(true);
  });
  it("never returns more than 96 KiB of JSON", () => {
    const wide = Array.from({ length: 40 }, () =>
      Array.from({ length: 12 }, () => "保".repeat(80)),
    );
    const body = boundedJson({ kind: "table", rows: wide, truncated: false });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(96 * 1024);
    expect(JSON.parse(body)).toMatchObject({ kind: "table", truncated: true });
  });
});
