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

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be";
export function textEncoding(head: Uint8Array): TextEncoding {
  if (head[0] === 0xff && head[1] === 0xfe) return "utf-16le";
  if (head[0] === 0xfe && head[1] === 0xff) return "utf-16be";
  return "utf-8";
}

// Inspect bytes, not the suffix. UTF-16 needs a BOM; guessing legacy encodings would turn
// arbitrary binary into apparent text. An incomplete final character is held at the read boundary.
export function decodeHead(
  head: Uint8Array,
  complete: boolean,
  encoding = textEncoding(head),
): string | undefined {
  if (encoding === "utf-8" && head.includes(0)) return undefined;
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(head, { stream: !complete });
    if (text.includes("\0")) return undefined;
    // Keep occasional terminal controls (masked below), but reject control-heavy binary data.
    let controls = 0;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code < 32 && ![9, 10, 12, 13, 27].includes(code)) controls++;
    }
    return controls > Math.max(2, text.length / 20) ? undefined : text;
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
  if (!complete && all.length > 1) all.pop(); // Keep a bounded excerpt even for one very long line.
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
  encoding = textEncoding(bytes),
): TextFileReply {
  const complete = fileBytes <= bytes.byteLength;
  let body = bytes;
  // A tail may begin inside a character: its continuation bytes are dropped.
  if (from === "end" && !complete && encoding === "utf-8") {
    let skip = 0;
    while (skip < 3 && ((body[skip] ?? 0) & 0xc0) === 0x80) skip++;
    body = body.subarray(skip);
  }
  if (from === "end" && !complete && encoding !== "utf-8" && body.length >= 2) {
    const unit =
      encoding === "utf-16le"
        ? (body[0] ?? 0) | ((body[1] ?? 0) << 8)
        : ((body[0] ?? 0) << 8) | (body[1] ?? 0);
    if (unit >= 0xdc00 && unit <= 0xdfff) body = body.subarray(2);
  }
  const text = decodeHead(body, complete || from === "end", encoding);
  if (text === undefined) return { kind: "none", reason: "binary" };
  const all = text.split(/\r\n|\r|\n/);
  if (!complete && all.length > 1) {
    // The line at the cut is partial. Keep a single long line instead of an empty view.
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
