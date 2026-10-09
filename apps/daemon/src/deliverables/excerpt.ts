import {
  fileExtension,
  type JsonPreview,
  KEY_SCAN_CHARS,
  PREVIEW_LIMITS,
  scanKeyLike,
  type TextFileReply,
  VIEWER_LIMITS,
} from "@localdot/protocol";

const L = PREVIEW_LIMITS;
// Control and direction-override characters would let a file disguise its own excerpt.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Excerpts show control bytes as a replacement mark.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// The start of a file as text, or undefined when it is not UTF-8 text. A character cut by the read
// boundary of an incomplete head is dropped rather than counted as binary.
export function decodeHead(head: Uint8Array, complete: boolean): string | undefined {
  if (head.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: !complete });
  } catch {
    return undefined;
  }
}
// One line as it may be shown: key-shaped tokens masked, hidden characters marked.
export function screenLine(line: string): string {
  const scan = scanKeyLike(line);
  if (scan.overflow) return "••••";
  let out = line;
  for (const m of [...scan.matches].reverse())
    out = `${out.slice(0, m.start)}••••${out.slice(m.end)}`;
  return out.replace(HIDDEN, "\uFFFD");
}
// A whole document as it may be shown, however long its lines: every token shaped like a key (the
// shortest is 35 characters) masked, hidden characters marked.
export function maskText(text: string): string {
  return text
    .replace(/AQ\.[A-Za-z0-9_.-]+|[A-Za-z0-9_-]{35,}/g, (token) =>
      token.length > KEY_SCAN_CHARS || scanKeyLike(token).matches.length > 0 ? "••••" : token,
    )
    .replace(HIDDEN, "�");
}
// Cut in UTF-16 units (what the schema counts) without splitting a character.
export function visible(text: string, max: number, screen = screenLine): string {
  const clean = screen(text);
  if (clean.length <= max) return clean;
  let out = "";
  for (const ch of clean) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export function textExcerpt(name: string, head: Uint8Array, fileBytes: number): JsonPreview {
  const complete = fileBytes <= head.byteLength;
  const text = decodeHead(head, complete);
  if (text === undefined) return { kind: "none", reason: "binary" };
  const all = text.split(/\r\n|\r|\n/);
  if (!complete) all.pop(); // The last line may be cut mid-way.
  const shown = all.slice(0, L.lines);
  const ext = fileExtension(name);
  return {
    kind: "text",
    format: ext === "md" || ext === "markdown" ? "markdown" : ext === "json" ? "json" : "plain",
    lines: shown.map((line) => visible(line, L.lineChars)),
    truncated: !complete || all.length > L.lines || shown.some((l) => l.length > L.lineChars),
  };
}

// RFC 4180, comma for .csv and tab for .tsv; a quoted field may span lines.
export function tableExcerpt(name: string, head: Uint8Array, fileBytes: number): JsonPreview {
  const complete = fileBytes <= head.byteLength;
  const text = decodeHead(head, complete);
  if (text === undefined) return { kind: "none", reason: "binary" };
  const delimiter = fileExtension(name) === "tsv" ? "\t" : ",";
  const rows: string[][] = [];
  let truncated = false;
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const endCell = () => {
    if (row.length >= L.columns || cell.length > L.cellChars) truncated = true;
    if (row.length < L.columns) row.push(visible(cell, L.cellChars));
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (; i < text.length && rows.length < L.rows; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else cell += ch;
  }
  if (i >= text.length && complete && (cell !== "" || row.length > 0)) endRow();
  if (i < text.length || !complete) truncated = true;
  return { kind: "table", rows, truncated };
}

// The reply never exceeds PREVIEW_LIMITS.jsonBytes: lines or rows are dropped from the end.
export function boundedJson(preview: JsonPreview): string {
  let value = preview;
  for (;;) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) <= L.jsonBytes) return body;
    if (value.kind === "text" && value.lines.length)
      value = { ...value, lines: value.lines.slice(0, -1), truncated: true };
    else if (value.kind === "table" && value.rows.length)
      value = { ...value, rows: value.rows.slice(0, -1), truncated: true };
    else return JSON.stringify({ kind: "none", reason: "too_large" });
  }
}

// A text file for the full preview: its first lines, or for a log its last, masked as excerpts are.
export function fileText(
  bytes: Uint8Array,
  fileBytes: number,
  from: "start" | "end",
): TextFileReply {
  const complete = fileBytes <= bytes.byteLength;
  let body = bytes;
  // A tail may begin inside a character: its continuation bytes are dropped.
  if (from === "end" && !complete) {
    let skip = 0;
    while (skip < 3 && ((body[skip] ?? 0) & 0xc0) === 0x80) skip++;
    body = body.subarray(skip);
  }
  const text = decodeHead(body, complete || from === "end");
  if (text === undefined) return { kind: "none", reason: "binary" };
  const all = text.split(/\r\n|\r|\n/);
  if (!complete) {
    // The line at the cut is partial.
    if (from === "end") all.shift();
    else all.pop();
  }
  const L = VIEWER_LIMITS;
  const shown = from === "end" ? all.slice(-L.textLines) : all.slice(0, L.textLines);
  return {
    kind: "text",
    from,
    lines: shown.map((line) => visible(line, L.textLineChars, maskText)),
    truncated:
      !complete || all.length > L.textLines || shown.some((l) => l.length > L.textLineChars),
  };
}
