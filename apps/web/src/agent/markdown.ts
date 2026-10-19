import { revealText } from "./reveal-text.ts";

export const MARKDOWN_LIMITS = Object.freeze({
  chars: 20_000,
  nodes: 512,
  depth: 3,
  tokenChars: 4096,
});
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  // A picture is never loaded: it shows as a link to it, named by its host.
  | { kind: "image"; text: string; href: string }
  | { kind: "strong" | "em"; children: Inline[] };
export type Align = "left" | "center" | "right" | null;
export interface ListItem {
  children: Inline[];
  // A task list's box: done or still to do.
  task?: "done" | "todo";
  list?: List;
}
export interface List {
  ordered: boolean;
  start: number;
  items: ListItem[];
}
// Each block keeps the source it came from, so a renderer can redraw only the blocks that changed
// as a message streams in.
export type Block = { source: string } & (
  | { kind: "paragraph"; children: Inline[]; pendingRow?: true }
  | { kind: "quote"; children: Inline[] }
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "code"; text: string; language: string }
  | ({ kind: "list" } & List)
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" }
);
type BlockBody = Block extends infer B ? (B extends Block ? Omit<B, "source"> : never) : never;

const MAX_COLUMNS = 12;
// A table row and its cells, without the outer pipes; escaped pipes stay in the cell.
function cells(line: string): string[] {
  const body = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/;
// Short lines only: the patterns backtrack over long runs of spaces.
const SHORT = 512;
const isRule = (line: string) => line.length <= SHORT && RULE.test(line);
const startsTable = (line: string, next: string) =>
  line.includes("|") &&
  next.length <= SHORT &&
  DELIMITER.test(next) &&
  cells(next).length === cells(line).length;
const align = (cell: string): Align =>
  cell.startsWith(":") && cell.endsWith(":")
    ? "center"
    : cell.endsWith(":")
      ? "right"
      : cell.startsWith(":")
        ? "left"
        : null;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-+*]|[0-9]{1,6}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const NUMERIC = /^[\s$€£¥+−-]*[\d.,]+\s*%?$/;
// A column of numbers reads right-aligned unless the table says otherwise.
function numericColumns(rows: string[][], columns: number): boolean[] {
  return Array.from(
    { length: columns },
    (_, i) =>
      rows.length > 0 &&
      rows.every((row) => (row[i] ?? "").trim() === "" || NUMERIC.test(row[i] ?? "")),
  );
}
// A line that starts another block ends a paragraph.
const OPENS_BLOCK = /^( {0,3}(`{3}|~{3}|[-+*]\s|[0-9]{1,6}[.)]\s|>)|#{1,6}\s)/;
export function safeMarkdownLink(raw: string): string | null {
  if (
    raw.length > 2048 ||
    !/^https?:\/\//i.test(raw) ||
    [...raw].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x20 || (code >= 0x7f && code <= 0x9f);
    })
  )
    return null;
  try {
    const url = new URL(raw);
    return url.hostname &&
      !url.username &&
      !url.password &&
      ["http:", "https:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
// GFM-style URL autolinks, bounded by the same token and URL limits as explicit
// links. Code is consumed before this runs; raw HTML never becomes markup.
function automaticLink(
  text: string,
  previous: string,
): { text: string; href: string; length: number } | null {
  const angle = text.startsWith("<");
  if (!angle && previous && !/[\s(*_~]/u.test(previous)) return null;
  const source = angle ? text.slice(1) : text;
  if (!/^(https?:\/\/|www\.)/i.test(source)) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: exclude control characters from URL candidates.
  const match = /^[^\s<>"'`\u0000-\u001f\u007f-\u009f，。！？；、]+/u.exec(source);
  if (!match) return null;
  let label = match[0];
  if (angle) {
    if (text[label.length + 1] !== ">") return null;
  } else {
    label = label.replace(/[?!.,:;*_~]+$/, "");
    // A closing parenthesis belongs to the URL only if it balances one inside it.
    while (
      label.endsWith(")") &&
      (label.match(/\)/g)?.length ?? 0) > (label.match(/\(/g)?.length ?? 0)
    )
      label = label.slice(0, -1);
  }
  const href = safeMarkdownLink(/^www\./i.test(label) ? `https://${label}` : label);
  return href ? { text: label, href, length: label.length + (angle ? 2 : 0) } : null;
}

export function parseMarkdown(raw: string): { blocks: Block[]; truncated: boolean } {
  let remaining = MARKDOWN_LIMITS.nodes;
  const input = raw.slice(0, MARKDOWN_LIMITS.chars).toWellFormed();
  const inline = (text: string, depth = 0): Inline[] => {
    if (depth >= MARKDOWN_LIMITS.depth || remaining <= 0) return [{ kind: "text", text }];
    const result: Inline[] = [];
    let plain = "",
      attempts = 0;
    const flush = () => {
      if (plain) {
        result.push({ kind: "text", text: plain });
        remaining--;
        plain = "";
      }
    };
    for (let i = 0; i < text.length; ) {
      if (remaining <= 1 || attempts > MARKDOWN_LIMITS.nodes) {
        plain += text.slice(i);
        break;
      }
      const rest = text.slice(i, i + MARKDOWN_LIMITS.tokenChars);
      const image = rest.startsWith("!["),
        link = image || rest.startsWith("[");
      if (link) {
        attempts++;
        const middle = rest.indexOf("](", image ? 2 : 1);
        if (middle >= 0 && middle <= 512) {
          const end = rest.indexOf(")", middle + 2);
          if (end > middle && end - middle <= 2050) {
            const rawLink = rest.slice(0, end + 1),
              href = safeMarkdownLink(rest.slice(middle + 2, end));
            if (href) {
              flush();
              result.push(
                image
                  ? { kind: "image", text: rest.slice(2, middle), href }
                  : { kind: "link", text: rest.slice(1, middle), href },
              );
              remaining--;
            } else plain += rawLink;
            i += end + 1;
            continue;
          }
        }
      }
      const marker =
        rest.startsWith("**") || rest.startsWith("__")
          ? rest.slice(0, 2)
          : rest[0] === "`" ||
              rest[0] === "*" ||
              (rest[0] === "_" && !/[\p{L}\p{N}]/u.test(text[i - 1] ?? ""))
            ? rest[0]
            : null;
      if (marker) {
        attempts++;
        const end = rest.indexOf(marker, marker.length);
        if (end > marker.length) {
          flush();
          const content = rest.slice(marker.length, end);
          if (marker === "`") result.push({ kind: "code", text: content });
          else
            result.push({
              kind: marker.length === 2 ? "strong" : "em",
              children: inline(content, depth + 1),
            });
          remaining--;
          i += end + marker.length;
          continue;
        }
      }
      const automatic = automaticLink(rest, text[i - 1] ?? "");
      if (automatic) {
        flush();
        result.push({ kind: "link", text: automatic.text, href: automatic.href });
        remaining--;
        i += automatic.length;
        continue;
      }
      if (rest[0] === "\\" && /[\\`*_[\]!]/.test(rest[1] ?? "")) {
        plain += rest[1];
        i += 2;
      } else {
        plain += text[i] ?? "";
        i++;
      }
    }
    flush();
    return result;
  };
  const lines = input.replace(/\r\n?/g, "\n").split("\n"),
    blocks: Block[] = [];
  let position = 0;
  let from = 0;
  // A block ends where the reading has got to; its source is the lines it was read from.
  const push = (block: BlockBody) =>
    blocks.push({ ...block, source: lines.slice(from, position).join("\n") } as Block);
  while (position < lines.length && remaining > 1) {
    const line = lines[position] ?? "";
    if (!line.trim()) {
      position++;
      continue;
    }
    from = position;
    const fence =
      line.length <= 128 ? /^ {0,3}(`{3,}|~{3,})([a-zA-Z0-9_-]{0,32})\s*$/.exec(line) : null;
    if (fence) {
      const marker = fence[1] ?? "```",
        body: string[] = [];
      position++;
      while (position < lines.length) {
        const next = lines[position] ?? "";
        position++;
        if (next.trim().length >= marker.length && [...next.trim()].every((c) => c === marker[0]))
          break;
        body.push(next);
      }
      push({ kind: "code", text: body.join("\n"), language: fence[2] ?? "" });
      remaining--;
      continue;
    }
    if (isRule(line)) {
      position++;
      push({ kind: "rule" });
      remaining--;
      continue;
    }
    const next = lines[position + 1] ?? "";
    if (startsTable(line, next)) {
      const head = cells(line).slice(0, MAX_COLUMNS);
      const columns = head.length;
      const aligns = cells(next).slice(0, columns).map(align);
      const raw: string[][] = [];
      position += 2;
      while (position < lines.length && remaining > columns + 1) {
        const row = lines[position] ?? "";
        if (!row.trim() || !row.includes("|")) break;
        raw.push(cells(row));
        remaining -= columns;
        position++;
      }
      const numbers = numericColumns(raw, columns);
      push({
        kind: "table",
        align: Array.from(
          { length: columns },
          (_, i) => aligns[i] ?? (numbers[i] ? "right" : null),
        ),
        head: head.map((cell) => inline(cell)),
        rows: raw.map((values) =>
          Array.from({ length: columns }, (_, i) => inline(values[i] ?? "")),
        ),
      });
      remaining--;
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      const body = [quote[1] ?? ""];
      position++;
      while (position < lines.length) {
        const more = QUOTE.exec(lines[position] ?? "");
        if (!more) break;
        body.push(more[1] ?? "");
        position++;
      }
      push({ kind: "quote", children: inline(body.join("\n").trim()) });
      remaining--;
      continue;
    }
    const list = line.length <= SHORT ? ITEM.exec(line) : null;
    if (list && (list[1] ?? "").length <= 3 && (list[3] ?? "").trim()) {
      const ordered = /^[0-9]/.test(list[2] ?? "");
      const root: List = {
        ordered,
        start: ordered ? Number.parseInt(list[2] ?? "1", 10) : 1,
        items: [],
      };
      // Each open list with the indent its items start at; deeper than three lists flattens.
      const open: { indent: number; list: List }[] = [{ indent: list[1]?.length ?? 0, list: root }];
      while (position < lines.length && remaining > 1) {
        const text = lines[position] ?? "";
        const item = text.length <= SHORT ? ITEM.exec(text) : null;
        if (!item) break;
        const indent = item[1]?.length ?? 0;
        const kind = /^[0-9]/.test(item[2] ?? "");
        if (open.length === 1 && indent <= (open[0]?.indent ?? 0) && kind !== ordered) break;
        while (open.length > 1 && indent < (open.at(-1)?.indent ?? 0)) open.pop();
        let level = open.at(-1) as { indent: number; list: List };
        const parent = level.list.items.at(-1);
        if (indent >= level.indent + 2 && parent && open.length < MARKDOWN_LIMITS.depth) {
          parent.list = {
            ordered: kind,
            start: kind ? Number.parseInt(item[2] ?? "1", 10) : 1,
            items: [],
          };
          level = { indent, list: parent.list };
          open.push(level);
        }
        const task = TASK.exec(item[3] ?? "");
        level.list.items.push(
          task
            ? { task: task[1] === " " ? "todo" : "done", children: inline(task[2] ?? "") }
            : { children: inline(item[3] ?? "") },
        );
        position++;
        remaining--;
      }
      push({ kind: "list", ...root });
      remaining--;
      continue;
    }
    const heading = line.length <= SHORT ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      position++;
      push({
        kind: "heading",
        level: heading[1]?.length ?? 1,
        children: inline(heading[2] ?? ""),
      });
      remaining--;
      continue;
    }
    const paragraph = [line];
    position++;
    while (
      position < lines.length &&
      (lines[position] ?? "").trim() &&
      !OPENS_BLOCK.test(lines[position] ?? "") &&
      !isRule(lines[position] ?? "") &&
      !startsTable(lines[position] ?? "", lines[position + 1] ?? "")
    )
      paragraph.push(lines[position++] ?? "");
    // A table's first row still waiting for its delimiter keeps a row's height meanwhile.
    const pendingRow = position === lines.length && paragraph.length === 1 && /^\s*\|/.test(line);
    push({
      kind: "paragraph",
      children: inline(paragraph.join("\n")),
      ...(pendingRow ? { pendingRow: true as const } : {}),
    });
    remaining--;
  }
  if (position < lines.length) {
    from = position;
    position = lines.length;
    push({
      kind: "paragraph",
      children: [{ kind: "text", text: lines.slice(from).join("\n") }],
    });
  }
  return { blocks, truncated: raw.length > MARKDOWN_LIMITS.chars };
}

// A link the parser won't make (a path, an unsafe address) is left as written; plain keeps its text.
const LINK_SOURCE = /!?\[([^\]\n]{0,512})\]\([^)\n]{0,2048}\)/g;
// A piece that ends a sentence or leads into the next runs on after a space; others are set apart.
const RUNS_ON = /[.!?…:;,]["'”’)\]]*$/u;

const inlineText = (nodes: readonly Inline[]): string =>
  nodes
    .map((node) =>
      "children" in node
        ? inlineText(node.children)
        : node.kind === "text"
          ? node.text.replace(LINK_SOURCE, "$1")
          : node.text,
    )
    .join("");

const listText = (list: List): string[] =>
  list.items.flatMap((item) => [
    inlineText(item.children),
    ...(item.list ? listText(item.list) : []),
  ]);

function blockText(block: Block): string[] {
  if (block.kind === "code") return [block.text];
  if (block.kind === "list") return listText(block);
  if (block.kind === "table") return [block.head, ...block.rows].flat().map(inlineText);
  if (block.kind === "rule") return [];
  return [inlineText(block.children)];
}

// dot's Markdown as one line of plain words, for a place too tight for blocks: its marks, heading
// and list markers, code fences and link addresses go, and its blocks run on as one line. Only
// spaces, tabs and line breaks collapse, so a hidden character stays for a reveal to show; text
// whose marks alone hold one (a link's address) is kept as written.
export function markdownToPlain(text: string): string {
  let line = "";
  for (const piece of parseMarkdown(text).blocks.flatMap(blockText)) {
    const words = piece.replace(/[ \t\n]+/g, " ").replace(/^ | $/g, "");
    if (words) line = line ? `${line}${RUNS_ON.test(line) ? " " : " · "}${words}` : words;
  }
  const was = revealText(text);
  if (!was.hidden) return line;
  const now = revealText(line);
  return now.hidden === was.hidden && now.bidi === was.bidi ? line : text;
}

const ENDS = /[.!?…:;。！？；：]["'”’)\]」』）]*$/u;
const WIDE_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;

// dot's Markdown as sentences to read aloud: code and tables are left out, since they read badly,
// and each block ends as a sentence so the voice pauses between them.
export function markdownToSpeech(text: string): string {
  return parseMarkdown(text)
    .blocks.filter((block) => block.kind !== "code" && block.kind !== "table")
    .flatMap(blockText)
    .map((piece) => piece.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((piece) => (ENDS.test(piece) ? piece : `${piece}${WIDE_END.test(piece) ? "。" : "."}`))
    .join(" ");
}
