import { createHash } from "node:crypto";
import { ULID_PATTERN } from "@localdot/protocol";

export const ENTRY_TEXT_MAX = 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const META = /[ \t]*<!-- ld:([^<>\r\n]*?) -->[ \t]*$/;
const FENCE = /^(```|~~~)/;
const CONTINUATION = /^[ \t]+\S/;

export type EntryMeta = {
  readonly id?: string;
  readonly src?: string;
  readonly at?: string;
  readonly pin?: true;
};
export interface MemoryEntryBlock {
  readonly kind: "entry";
  readonly raw: string;
  readonly id: string;
  readonly text: string;
  readonly meta: EntryMeta;
  readonly revision: string;
}
export interface RawBlock {
  readonly kind: "raw";
  readonly raw: string;
}
export type MemoryBlock = MemoryEntryBlock | RawBlock;

export const isEntry = (b: MemoryBlock): b is MemoryEntryBlock => b.kind === "entry";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const revisionOf = (raw: string) => sha(raw).slice(0, 16);
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const withoutEol = (s: string) => s.replace(/\r?\n$/, "");

export function parseMeta(body: string): EntryMeta {
  const fields = new Map<string, string>();
  for (const pair of body.trim().split(/\s+/)) {
    const at = pair.indexOf("=");
    if (at > 0) fields.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const id = fields.get("id");
  const src = fields.get("src");
  const at = fields.get("at");
  return {
    ...(id && ULID_PATTERN.test(id) ? { id } : {}),
    ...(src && (src === "user" || ULID_PATTERN.test(src)) ? { src } : {}),
    ...(at && DAY.test(at) ? { at } : {}),
    ...(fields.get("pin") === "1" ? { pin: true as const } : {}),
  };
}

export function metaComment(meta: EntryMeta): string {
  if (!meta.id) return "";
  const parts = [`id=${meta.id}`];
  if (meta.src) parts.push(`src=${meta.src}`);
  if (meta.at) parts.push(`at=${meta.at}`);
  if (meta.pin) parts.push("pin=1");
  return `<!-- ld:${parts.join(" ")} -->`;
}

function entryBlock(raw: string, seen: Set<string>, copies: Map<string, number>): MemoryEntryBlock {
  const body = withoutEol(raw);
  const match = META.exec(body);
  const meta = match ? parseMeta(match[1] ?? "") : {};
  const visible = match ? body.slice(0, match.index) : body;
  const text = visible
    .split(/\r?\n/)
    .map((line, n) => (n === 0 ? line.slice(2) : line.replace(/^(?: {1,2}|\t)/, "")))
    .join("\n")
    .trimEnd();
  const n = copies.get(raw) ?? 0;
  copies.set(raw, n + 1);
  const id = meta.id && !seen.has(meta.id) ? meta.id : `x${sha(`${n}\0${raw}`).slice(0, 16)}`;
  seen.add(id);
  return { kind: "entry", raw, id, text, meta, revision: revisionOf(raw) };
}

// An entry is a "- " line at column 0 outside a code fence, with the indented lines under it.
export function parseMemory(text: string): MemoryBlock[] {
  const all = lines(text);
  const blocks: MemoryBlock[] = [];
  const seen = new Set<string>();
  const copies = new Map<string, number>();
  let raw = "";
  let fence: string | null = null;
  const flush = () => {
    if (raw) blocks.push({ kind: "raw", raw });
    raw = "";
  };
  for (let i = 0; i < all.length; ) {
    const line = all[i] as string;
    const marker = FENCE.exec(line)?.[1];
    if (fence || marker || !line.startsWith("- ")) {
      if (fence && marker === fence) fence = null;
      else if (!fence && marker) fence = marker;
      raw += line;
      i++;
      continue;
    }
    let end = i + 1;
    while (end < all.length && CONTINUATION.test(all[end] as string)) end++;
    flush();
    blocks.push(entryBlock(all.slice(i, end).join(""), seen, copies));
    i = end;
  }
  flush();
  return blocks;
}

export const serializeMemory = (blocks: readonly MemoryBlock[]) =>
  blocks.map((b) => b.raw).join("");
export const eolOf = (text: string): "\n" | "\r\n" =>
  /\r\n$/.test(lines(text)[0] ?? "") ? "\r\n" : "\n";

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function stripComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replaceAll("<!--", "")
    .replaceAll("-->", "");
}

export function entryTextProblem(text: string): string | undefined {
  if (!text.isWellFormed() || text.includes("\0")) return "invalid text";
  if (!text.trim()) return "empty";
  if (text.length > ENTRY_TEXT_MAX) return "too long";
  if (text.includes("<!--") || text.includes("-->")) return "comment markers";
  return undefined;
}

export function renderEntry(text: string, meta: EntryMeta, eol: "\n" | "\r\n" = "\n"): string {
  const parts = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (parts[0]) parts[0] = parts[0].replace(/^[-*] /, "");
  if (!parts.length || !parts[0]) throw new RangeError("empty memory entry");
  const comment = metaComment(meta);
  const body = [`- ${parts[0]}`, ...parts.slice(1).map((l) => `  ${l}`)].join(eol);
  return `${body}${comment ? ` ${comment}` : ""}${eol}`;
}

// The file as dot reads it, without the metadata comments, and where each comment was.
export function projection(text: string) {
  const spans: { at: number; length: number }[] = [];
  let visible = "";
  let removed = 0;
  let offset = 0;
  for (const block of parseMemory(text)) {
    const match = block.kind === "entry" ? META.exec(withoutEol(block.raw)) : null;
    if (match) {
      visible += block.raw.slice(0, match.index) + block.raw.slice(match.index + match[0].length);
      spans.push({ at: offset + match.index - removed, length: match[0].length });
      removed += match[0].length;
    } else visible += block.raw;
    offset += block.raw.length;
  }
  return { visible, spans };
}

// A comment exactly at the match start stays before the new text; one exactly at its end stays
// after it; comments strictly inside the replaced range go with the replaced text.
export function replaceVisible(text: string, oldText: string, newText: string) {
  const { visible, spans } = projection(text);
  const at = visible.indexOf(oldText);
  if (!oldText || at < 0) return "missing" as const;
  if (visible.indexOf(oldText, at + 1) >= 0) return "ambiguous" as const;
  const end = at + oldText.length;
  const shift = (v: number, inclusive: boolean) =>
    spans.filter((s) => (inclusive ? s.at <= v : s.at < v)).reduce((n, s) => n + s.length, 0);
  return text.slice(0, at + shift(at, true)) + newText + text.slice(end + shift(end, false));
}

export function tagAppend(
  text: string,
  src: string,
  day: string,
  eol: "\n" | "\r\n",
  newId: () => string,
): string {
  const source = text.trimEnd() + eol;
  const blocks = parseMemory(source);
  const meta = () => ({ id: newId(), src, at: day });
  if (!blocks.some(isEntry)) return /^#/m.test(source) ? source : renderEntry(source, meta(), eol);
  return blocks
    .map((b) => (b.kind === "entry" && !b.meta.id ? renderEntry(b.text, meta(), eol) : b.raw))
    .join("");
}

export function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

// What a task boots with: pinned entries first under their own heading, then the file without
// metadata, dropping the oldest unpinned entries once the budget is spent.
export function bootView(text: string, budget: number): string {
  const blocks = parseMemory(text);
  const list = blocks.filter(isEntry);
  const position = new Map(list.map((e, i) => [e, i] as const));
  const pos = (e: MemoryEntryBlock) => position.get(e) ?? 0;
  const line = (e: MemoryEntryBlock) => `- ${e.text.replaceAll("\n", "\n  ")}\n`;
  const pinned = list.filter((e) => e.meta.pin);
  const header = "## Always remember\n";
  let used =
    (pinned.length ? header.length + 1 : 0) +
    blocks.reduce((n, b) => n + (b.kind === "raw" ? b.raw.length : 0), 0);
  const ranked = [...list].sort((a, b) => {
    if (Boolean(a.meta.pin) !== Boolean(b.meta.pin)) return a.meta.pin ? -1 : 1;
    if (a.meta.pin) return pos(a) - pos(b);
    if (Boolean(a.meta.at) !== Boolean(b.meta.at)) return a.meta.at ? -1 : 1;
    if (a.meta.at && b.meta.at && a.meta.at !== b.meta.at) return a.meta.at < b.meta.at ? 1 : -1;
    return pos(b) - pos(a);
  });
  const keep = new Set<MemoryEntryBlock>();
  for (const e of ranked) {
    const cost = line(e).length;
    if (used + cost > budget) continue;
    used += cost;
    keep.add(e);
  }
  const top = pinned
    .filter((e) => keep.has(e))
    .map(line)
    .join("");
  const body = blocks
    .map((b) => (b.kind === "raw" ? b.raw : !b.meta.pin && keep.has(b) ? line(b) : ""))
    .join("");
  return cutTo(`${top ? `${header}${top}\n` : ""}${body}`, budget);
}
