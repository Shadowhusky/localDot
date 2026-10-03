import { z } from "zod";

// desktopd's shell, files and browser routes (spec "desktopd" table: shell(cmd), files.*,
// browser.read(), browser.navigate(url)). Paths are the desktop user's home or below it.

export const ShellRequest = z.object({
  command: z.string().min(1).max(8000),
  cwd: z.string().max(1024).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  maxOutputBytes: z
    .number()
    .int()
    .min(1024)
    .max(4 * 1024 * 1024)
    .default(1024 * 1024),
});
export type ShellRequest = z.input<typeof ShellRequest>;

// NDJSON lines on /shell: output chunks in order, then one ShellDone.
export const ShellChunk = z.object({
  stream: z.enum(["stdout", "stderr"]),
  chunk: z.string(),
});
export type ShellChunk = z.infer<typeof ShellChunk>;
export const ShellDone = z.object({
  done: z.literal(true),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  ms: z.number().nonnegative(),
});
export type ShellDone = z.infer<typeof ShellDone>;

export const FileReadRequest = z.object({
  path: z.string().min(1).max(1024),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(4 * 1024 * 1024)
    .default(256 * 1024),
});
export type FileReadRequest = z.input<typeof FileReadRequest>;
export const FileReadResult = z.object({
  path: z.string(),
  content: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  binary: z.boolean(),
});
export type FileReadResult = z.infer<typeof FileReadResult>;

export const FileWriteRequest = z.object({
  path: z.string().min(1).max(1024),
  content: z.string().max(1_000_000),
});
export type FileWriteRequest = z.infer<typeof FileWriteRequest>;

export const FileEditRequest = z.object({
  path: z.string().min(1).max(1024),
  oldText: z.string().min(1).max(100_000),
  newText: z.string().max(100_000),
});
export type FileEditRequest = z.infer<typeof FileEditRequest>;

// A write or an edit: the patch is what the diff panel shows (file.change).
export const FileChangeResult = z.object({
  path: z.string(),
  op: z.enum(["create", "modify"]),
  patch: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type FileChangeResult = z.infer<typeof FileChangeResult>;

export const FileListRequest = z.object({ path: z.string().min(1).max(1024) });
export type FileListRequest = z.infer<typeof FileListRequest>;
export const FileEntry = z.object({
  name: z.string(),
  type: z.enum(["file", "dir", "link", "other"]),
  bytes: z.number().int().nonnegative(),
});
export type FileEntry = z.infer<typeof FileEntry>;
export const FileListResult = z.object({
  path: z.string(),
  entries: z.array(FileEntry),
  truncated: z.boolean(),
});
export type FileListResult = z.infer<typeof FileListResult>;

export const BrowserReadRequest = z.object({
  maxChars: z.number().int().min(500).max(100_000).default(20_000),
});
export type BrowserReadRequest = z.input<typeof BrowserReadRequest>;
export const BrowserReadResult = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
  // A compact outline of the page's accessibility tree: one "role name" line per node.
  outline: z.string(),
  truncated: z.boolean(),
});
export type BrowserReadResult = z.infer<typeof BrowserReadResult>;

export const BrowserNavigateRequest = z.object({ url: z.string().min(1).max(2048) });
export type BrowserNavigateRequest = z.infer<typeof BrowserNavigateRequest>;
export const BrowserNavigateResult = z.object({
  url: z.string(),
  title: z.string(),
  loaded: z.boolean(),
});
export type BrowserNavigateResult = z.infer<typeof BrowserNavigateResult>;

// Only web pages: never file:, javascript:, data:, chrome: or a DevTools URL.
export function webUrl(raw: string): URL | undefined {
  const value = raw.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
  const hostWithPort = /^[^/?#:@\s]+:\d+(?:[/?#]|$)/.test(value);
  if (scheme && !hostWithPort && !/^https?:/i.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(scheme && !hostWithPort ? value : `https://${value}`);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
}
