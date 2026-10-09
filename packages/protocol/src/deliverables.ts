import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";
import { RecordingState } from "./recording.ts";

const Ulid = z.string().regex(ULID_PATTERN);

export type FileKind = "image" | "text" | "table" | "office" | "pdf" | "attachment";
// Pictures are decoded on the Mac, so only the four common raster formats preview; TIFF, AVIF and
// HEIF stay attachments and their decoders never run.
const KINDS: Readonly<Record<string, FileKind>> = Object.freeze({
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  txt: "text",
  md: "text",
  markdown: "text",
  json: "text",
  log: "text",
  yaml: "text",
  yml: "text",
  toml: "text",
  csv: "table",
  tsv: "table",
  ods: "office",
  odt: "office",
  odp: "office",
  xlsx: "office",
  xls: "office",
  docx: "office",
  doc: "office",
  pptx: "office",
  ppt: "office",
  pps: "office",
  ppsx: "office",
  key: "office",
  rtf: "office",
  pdf: "pdf",
});
// Opened on the Mac with its default app. Everything that can run code, open a browser on a local
// file or follow a link (scripts, apps, installers, html, svg, webloc) is absent, and so is every
// format that can carry VBA macros (xlsm/docm, and the legacy binary doc/xls/ppt/pps). Slide shows
// and Keynote files only preview.
const OPENABLE = new Set([
  ...Object.keys(KINDS).filter(
    (ext) =>
      !["json", "yaml", "yml", "toml", "log", "doc", "xls", "ppt", "pps", "ppsx", "key"].includes(
        ext,
      ),
  ),
  "tif",
  "tiff",
  "avif",
  "heic",
  "mp4",
  "mov",
  "m4a",
  "mp3",
  "wav",
]);

// Source code shows as text; none of it is ever run or opened on the Mac.
const CODE = new Set([
  ..."js mjs cjs jsx ts tsx py rb go rs java kt kts swift c h cc cpp hpp cs php sh bash zsh".split(
    " ",
  ),
  ..."fish ps1 sql css scss less ini cfg conf lua r pl dart scala vue svelte".split(" "),
]);

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
}
export function fileKind(name: string): FileKind {
  const ext = fileExtension(name);
  return KINDS[ext] ?? (CODE.has(ext) ? "text" : "attachment");
}

// How the full preview shows a file. Pictures, SVG, PDF, pages and media are drawn by the browser
// from the file itself; text and tables come from the daemon already masked.
export type ViewerKind =
  | "picture"
  | "svg"
  | "pdf"
  | "html"
  | "text"
  | "table"
  | "sheet"
  | "audio"
  | "video"
  | "page"
  | "details";
const VIEWERS: Readonly<Record<string, ViewerKind>> = Object.freeze({
  svg: "svg",
  html: "html",
  htm: "html",
  // Its source only, as text: the card's excerpt leaves it out.
  xml: "text",
  xlsx: "sheet",
  ods: "sheet",
  ...Object.fromEntries("mp3 m4a wav ogg oga opus flac aac".split(" ").map((e) => [e, "audio"])),
  ...Object.fromEntries("mp4 m4v mov webm".split(" ").map((e) => [e, "video"])),
});
export function viewerKind(name: string): ViewerKind {
  const known = VIEWERS[fileExtension(name)];
  if (known) return known;
  const kind = fileKind(name);
  if (kind === "image") return "picture";
  if (kind === "office") return "page";
  return kind === "attachment" ? "details" : kind;
}
export type TextFormat = "plain" | "code" | "markdown" | "json" | "log";
export function textFormat(name: string): TextFormat {
  const ext = fileExtension(name);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "json" || ext === "log") return ext;
  return ext === "txt" ? "plain" : "code";
}
const PRESENTATIONS = new Set(["pptx", "ppt", "pps", "ppsx", "odp", "key"]);
// Shown a slide at a time in the full preview.
export function isPresentation(name: string): boolean {
  return PRESENTATIONS.has(fileExtension(name));
}
export function canOpenOnMac(name: string): boolean {
  return OPENABLE.has(fileExtension(name));
}

export const PREVIEW_LIMITS = Object.freeze({
  imagePx: 1024,
  pngBytes: 2 * 1024 * 1024,
  jsonBytes: 96 * 1024,
  lines: 40,
  lineChars: 240,
  rows: 40,
  columns: 12,
  cellChars: 80,
  readBytes: 64 * 1024,
  imageInputBytes: 50 * 1024 * 1024,
  imageInputPixels: 50_000_000,
  convertBytes: 25 * 1024 * 1024,
  compareBytes: 1024 * 1024,
});

export const PreviewReason = z.enum([
  "attachment",
  "binary",
  "too_large",
  "computer_off",
  "busy",
  "failed",
  "missing",
]);
export type PreviewReason = z.infer<typeof PreviewReason>;
export const JsonPreview = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    format: z.enum(["plain", "markdown", "json"]),
    lines: z.array(z.string().max(PREVIEW_LIMITS.lineChars)).max(PREVIEW_LIMITS.lines),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("table"),
    rows: z
      .array(z.array(z.string().max(PREVIEW_LIMITS.cellChars)).max(PREVIEW_LIMITS.columns))
      .max(PREVIEW_LIMITS.rows),
    truncated: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("none"), reason: PreviewReason }),
]);
export type JsonPreview = z.infer<typeof JsonPreview>;

// What the full preview reads or shows of one file. Larger pictures, PDFs, pages and workbooks show
// "Too large to preview"; longer text and tables show their start (a log its end).
export const VIEWER_LIMITS = Object.freeze({
  pictureBytes: 40 * 1024 * 1024,
  svgBytes: 5 * 1024 * 1024,
  pdfBytes: 50 * 1024 * 1024,
  htmlBytes: 5 * 1024 * 1024,
  sheetBytes: 20 * 1024 * 1024,
  sheetXmlBytes: 32 * 1024 * 1024,
  textBytes: 2 * 1024 * 1024,
  textLines: 20_000,
  textLineChars: 2_000,
  tableRows: 500,
  tableColumns: 64,
  tableCellChars: 400,
  tableCountBytes: 16 * 1024 * 1024,
  tableJsonBytes: 3 * 1024 * 1024,
  sheets: 64,
});
const V = VIEWER_LIMITS;
const NoPreview = z.strictObject({ kind: z.literal("none"), reason: PreviewReason });
export const TextFileReply = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    lines: z.array(z.string().max(V.textLineChars)).max(V.textLines),
    // A log is read from its end.
    from: z.enum(["start", "end"]),
    truncated: z.boolean(),
  }),
  NoPreview,
]);
export type TextFileReply = z.infer<typeof TextFileReply>;
export const TableFileReply = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("table"),
    sheets: z.array(z.string().max(200)).max(V.sheets),
    sheet: z.number().int().min(0),
    rows: z.array(z.array(z.string().max(V.tableCellChars)).max(V.tableColumns)).max(V.tableRows),
    // Null when the file is too long to count.
    totalRows: z.number().int().nonnegative().nullable(),
    columns: z.number().int().nonnegative(),
  }),
  NoPreview,
]);
export type TableFileReply = z.infer<typeof TableFileReply>;
export const PREVIEW_TICKET = /^[A-Za-z0-9_-]{43}$/;
export const PreviewLinkReply = z.strictObject({
  base: z.string().regex(/^\/file-previews\/[A-Za-z0-9_-]{43}\/$/),
});

export const MAX_OUTPUT_VERSION = 10_000;
const OutputVersion = z.number().int().min(1).max(MAX_OUTPUT_VERSION);
// The same names the daemon stores results under, never starting with a dot.
const OutputName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[-\w. ]+$/)
  .refine((name) => !name.startsWith("."));
export const ReviseLink = z.strictObject({
  sessionId: Ulid,
  name: OutputName,
  version: OutputVersion.nullable(),
});
export type ReviseLink = z.infer<typeof ReviseLink>;

export const FileVersion = z.strictObject({
  sessionId: Ulid,
  version: OutputVersion.nullable(),
  label: z.number().int().min(1),
  bytes: z.number().int().nonnegative(),
  resultId: Ulid,
  tMs: z.number().nonnegative(),
  available: z.boolean(),
});
export type FileVersion = z.infer<typeof FileVersion>;
export const FileVersionsReply = z.strictObject({
  name: z.string().min(1).max(200),
  versions: z.array(FileVersion).max(64),
});
export type FileVersionsReply = z.infer<typeof FileVersionsReply>;

export const CompareReply = z.strictObject({
  from: z.number().int().min(1),
  to: z.number().int().min(1),
  patch: z.string().max(65_000),
  truncated: z.boolean(),
});
export type CompareReply = z.infer<typeof CompareReply>;

export const ProofFrame = z.strictObject({
  role: z.enum(["start", "change", "end"]),
  frameId: Ulid,
  tMs: z.number().nonnegative(),
});
export type ProofFrame = z.infer<typeof ProofFrame>;
export const ResultProof = z.strictObject({
  resultId: Ulid,
  frames: z.array(ProofFrame).max(3),
  checked: z.string().max(200).nullable(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
});
export type ResultProof = z.infer<typeof ResultProof>;
export const ProofReply = z.strictObject({
  recording: RecordingState,
  results: z.array(ResultProof).max(64),
});
export type ProofReply = z.infer<typeof ProofReply>;

export const OpenOnMacRequest = z.strictObject({ version: OutputVersion.nullable() });
export const OpenOnMacReply = z.strictObject({ path: z.string().max(1024), reused: z.boolean() });
export type OpenOnMacReply = z.infer<typeof OpenOnMacReply>;

export const ReviseRequest = z.strictObject({
  cellId: Ulid,
  version: OutputVersion.nullable(),
  // The daemon adds a line saying where the file is; a task is at most 8,000 characters.
  text: z.string().min(1).max(7500),
});
export type ReviseRequest = z.infer<typeof ReviseRequest>;
export const ReviseReply = z.strictObject({ sessionId: Ulid });
