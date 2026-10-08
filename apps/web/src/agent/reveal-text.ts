// What an approval card shows for a value: every character in order, with nothing able to hide
// part of it. Long blank runs and blank-line floods collapse into counted markers, other blanks
// become visible dots, and invisible, control, look-alike space and bidi characters become codes.
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
  "\\p{Cc}\\p{Cf}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000" +
  "\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u2800\\u3164\\uffa0\\ufe00-\\ufe0d\\u{e0100}-\\u{e01ef}";
const TOKEN = new RegExp(`[ \\t]+|([${HIDDEN}])\\1*|[^ \\t${HIDDEN}]+`, "gu");
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const BLANK_LINE = /^[ \t]*$/;
const count = (n: number) => n.toLocaleString("en-US");

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
  const line = (row: string) => {
    for (const match of row.matchAll(TOKEN)) {
      const token = match[0];
      const at = match.index;
      if (token[0] === " " || token[0] === "\t") {
        if (token === " " && at > 0 && at + 1 < row.length) text += token;
        else if (token.length <= LONGEST_DOTS)
          mark({ kind: "blank", text: token.replaceAll(" ", "·").replaceAll("\t", "→") });
        else mark({ kind: "run", text: blanks(token) });
      } else if (match[1] !== undefined) {
        const point = match[1].codePointAt(0) ?? 0;
        const repeats = [...token].length;
        const code = `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
        const isBidi = BIDI.test(match[1]);
        hidden = true;
        bidi ||= isBidi;
        mark({
          kind: "hidden",
          text: repeats > 1 ? `${code} ×${count(repeats)}` : code,
          bidi: isBidi,
        });
      } else text += token;
    }
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
      mark({ kind: "lines", text: `${count(end - i)} blank lines` });
      i = end;
    } else line(rows[i++] ?? "");
  }
  if (text) parts.push({ kind: "text", text });
  return { parts, hidden, bidi, lines: rows.length };
}
