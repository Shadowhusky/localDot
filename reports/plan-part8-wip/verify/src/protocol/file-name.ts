// A file name from a web page (Content-Disposition, Chromium's suggestedFilename) is untrusted:
// it may carry a path, control characters, or bidi overrides that make "invoice\u{202e}fdp.exe"
// read as "invoiceexe.pdf". safeFileName gives a name that is one path component, printable,
// visible as written, at most 120 code points, and keeps a short extension.
const MAX_NAME = 120;
const MAX_EXT = 16;
// C0 and C1 controls, DEL, bidi embeddings, overrides and isolates, marks, zero-width characters,
// the BOM and the Unicode line and paragraph separators.
const INVISIBLE =
  /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2069}\u{feff}]/gu;
const RESERVED = /[/\\:*?"<>|]/gu;

export function safeFileName(raw: string, fallback = "download"): string {
  let name = raw.normalize("NFC").replace(INVISIBLE, "").replace(RESERVED, "_");
  name = name.replace(/\s+/gu, " ").replace(/^[\s.]+|[\s.]+$/gu, "");
  if (name === "") return fallback;
  const chars = [...name];
  if (chars.length <= MAX_NAME) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const keep = [...ext].length <= MAX_EXT ? ext : "";
  const stem = [...(keep ? name.slice(0, dot) : name)].slice(0, MAX_NAME - [...keep].length - 1);
  return `${stem.join("").replace(/[\s.]+$/u, "")}…${keep}`;
}
