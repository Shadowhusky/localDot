// What an approval card shows for a value: every character in order, with nothing able to hide
// part of it. Long blank runs and floods of lines that draw nothing collapse into counted markers,
// other blanks become visible dots, and invisible, control, look-alike space and bidi characters
// become codes.
export type RevealPart =
  | { kind: "text"; text: string }
  | { kind: "blank"; text: string }
  | { kind: "run"; text: string }
  | { kind: "lines"; text: string }
  | { kind: "hidden"; text: string; bidi: boolean };
export interface Revealed {
  parts: RevealPart[];
  hidden: boolean;
  bidi: boolean;
  lines: number;
}

const LONGEST_DOTS = 16;
const FEWEST_COLLAPSED_LINES = 3;
const HIDDEN =
  "\\p{Cc}\\p{Cf}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}" +
  "\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\u2800";
// U+FE0E and U+FE0F are ignorable too, but right after a pictograph they only pick its style.
const SHOWN = `(?:(?![${HIDDEN}])\\p{Extended_Pictographic}[\\ufe0e\\ufe0f]?|[^ \\t${HIDDEN}])+`;
const TOKEN = new RegExp(`[ \\t]+|${SHOWN}|([${HIDDEN}])\\1*`, "gu");
const DRAWN = new RegExp(`[^ \\t\\p{M}${HIDDEN}]`, "uy");
const BASE = /\P{M}/u;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const BLANK_LINE = new RegExp(`^[ \\t\\p{M}${HIDDEN}]*$`, "u");
const count = (n: number) => n.toLocaleString("en-US");
const code = (point: number, repeats: number) => {
  const name = `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
  return repeats > 1 ? `${name}\u00a0×${count(repeats)}` : name;
};

function blanks(run: string): string {
  const tabs = run.split("\t").length - 1;
  const kind = tabs === 0 ? "spaces" : tabs === run.length ? "tabs" : "spaces and tabs";
  return `${count(run.length)} ${kind}`;
}

export function revealText(value: string): Revealed {
  const parts: RevealPart[] = [];
  let text = "",
    hidden = false,
    bidi = false;
  const mark = (part: RevealPart) => {
    if (text) parts.push({ kind: "text", text });
    text = "";
    parts.push(part);
  };
  const flag = (label: string, isBidi: boolean) => {
    hidden = true;
    bidi ||= isBidi;
    mark({ kind: "hidden", text: label, bidi: isBidi });
  };
  // A single space reads as a space only between two characters that are drawn.
  const drawnAt = (row: string, at: number) => {
    DRAWN.lastIndex = at;
    return DRAWN.test(row);
  };
  const line = (row: string) => {
    let drawn = false;
    for (const match of row.matchAll(TOKEN)) {
      const token = match[0];
      if (token[0] === " " || token[0] === "\t") {
        if (token === " " && drawn && drawnAt(row, match.index + 1)) text += token;
        else if (token.length <= LONGEST_DOTS)
          mark({ kind: "blank", text: token.replaceAll(" ", "·").replaceAll("\t", "→") });
        else mark({ kind: "run", text: blanks(token) });
        drawn = false;
      } else if (match[1] !== undefined) {
        flag(code(match[1].codePointAt(0) ?? 0, [...token].length), BIDI.test(match[1]));
        drawn = false;
      } else {
        text += token;
        drawn = BASE.test(token);
      }
    }
  };
  const blankLines = (rows: string[]) => {
    const found = new Map<number, number>();
    let isBidi = false;
    for (const row of rows)
      for (const char of row) {
        if (char === " " || char === "\t") continue;
        const point = char.codePointAt(0) ?? 0;
        found.set(point, (found.get(point) ?? 0) + 1);
        isBidi ||= BIDI.test(char);
      }
    const label = `${count(rows.length)} blank lines`;
    if (!found.size) mark({ kind: "lines", text: label });
    else flag(`${label} with ${[...found].map(([point, n]) => code(point, n)).join(", ")}`, isBidi);
  };
  // A CR only counts as part of a line break when an LF follows it.
  const rows = value
    .split("\n")
    .map((row, i, all) => (i < all.length - 1 && row.endsWith("\r") ? row.slice(0, -1) : row));
  for (let i = 0; i < rows.length; ) {
    if (i > 0) text += "\n";
    let end = i;
    while (end < rows.length && BLANK_LINE.test(rows[end] ?? "")) end++;
    if (end - i >= FEWEST_COLLAPSED_LINES) {
      blankLines(rows.slice(i, end));
      i = end;
    } else line(rows[i++] ?? "");
  }
  if (text) parts.push({ kind: "text", text });
  return { parts, hidden, bidi, lines: rows.length };
}

// The parts as one plain text, each marker in brackets: still every character, in order, for a
// place that takes only text, such as a field's label.
export function plainReveal(parts: readonly RevealPart[]): string {
  return parts
    .map((part) => (part.kind === "text" || part.kind === "blank" ? part.text : `[${part.text}]`))
    .join("");
}

// What a reader is told when a value hides characters.
export function hiddenWarning(value: Revealed): string | undefined {
  if (!value.hidden) return undefined;
  return value.bidi
    ? "Contains hidden characters that change text direction, shown as U+ codes."
    : "Contains hidden characters, shown as U+ codes.";
}
