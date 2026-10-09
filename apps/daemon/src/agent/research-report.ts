import { KEY_SCAN_CHARS, scanKeyLike } from "@localdot/protocol";
import { siteOf } from "./research.ts";

export interface ReportSource {
  readonly n: number;
  readonly url: string;
  readonly title: string;
  readonly passages: readonly string[];
}
export interface ReportDraft {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly sources: readonly ReportSource[];
  readonly date: Date;
}
export interface BuiltReport {
  readonly markdown: string;
  // The sources the report cites, by their numbers in the source list, in citation order.
  readonly cited: readonly number[];
  // Numbers the text cites that no source has; they are left out.
  readonly unknown: readonly number[];
}

// [3], [3, 5], [3-5] or [3–5], never a link's text ([3](…)) or a footnote ([^3]).
const GROUP = /\[(\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\](?!\()/g;
const MAX_RANGE = 20;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const SOURCES_HEAD =
  /^#{1,6}\s*(?:sources|references|bibliography|works cited|citations)\s*:?\s*$/i;
const PASSAGE_SHOWN = 400;
export const REDACTED_KEY = "[redacted]";

function numbersIn(group: string): number[] {
  const out: number[] = [];
  for (const part of group.split(",")) {
    const [from, to] = part.split(/[–-]/).map((n) => Number.parseInt(n.trim(), 10));
    if (from === undefined || Number.isNaN(from)) continue;
    if (to === undefined || Number.isNaN(to)) out.push(from);
    else for (let n = from; n <= to && n - from < MAX_RANGE; n++) out.push(n);
  }
  return out;
}

// Numbers as a citation: [1], [1, 4], or a run of three or more as [2–4].
export function citation(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] as number) + 1) j++;
    const from = sorted[i] as number;
    const to = sorted[j] as number;
    if (j - i >= 2) parts.push(`${from}–${to}`);
    else for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
    i = j + 1;
  }
  return `[${parts.join(", ")}]`;
}

// Applies fix to the prose of Markdown, leaving fenced code blocks and inline code untouched.
function prose(markdown: string, fix: (text: string) => string): string {
  let fence: string | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const open = FENCE.exec(line)?.[1];
      if (fence) {
        if (open && open[0] === fence[0] && open.length >= fence.length) fence = undefined;
        return line;
      }
      if (open) {
        fence = open;
        return line;
      }
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? part : fix(part)))
        .join("");
    })
    .join("\n");
}

// Masks recognisable API keys and tokens, line by line within the scanner's bound.
export function maskKeys(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const pieces = line.length > KEY_SCAN_CHARS ? (line.match(/[^\s]*\s*/g) ?? [line]) : [line];
      let out = "";
      let chunk = "";
      const flush = () => {
        out += maskChunk(chunk);
        chunk = "";
      };
      for (const piece of pieces) {
        if (chunk.length + piece.length > KEY_SCAN_CHARS) flush();
        chunk += piece;
      }
      flush();
      return out;
    })
    .join("\n");
}
function maskChunk(chunk: string): string {
  if (chunk.length > KEY_SCAN_CHARS) return chunk;
  let text = chunk;
  for (;;) {
    const scan = scanKeyLike(text);
    if (!scan.matches.length) return text;
    for (const match of [...scan.matches].reverse())
      text = text.slice(0, match.start) + REDACTED_KEY + text.slice(match.end);
    if (!scan.overflow) return text;
  }
}

function linkText(title: string): string {
  return title.replace(/([\\[\]*_`<>])/g, "\\$1");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function longDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// The body as dot wrote it, without a title of its own or a sources list of its own: the report
// adds both.
function bodyOf(body: string): string {
  const lines = body.trim().split("\n");
  if (/^#\s/.test(lines[0] ?? "")) lines.shift();
  const end = lines.findIndex((line) => SOURCES_HEAD.test(line.trim()));
  return (end === -1 ? lines : lines.slice(0, end)).join("\n").trim();
}

// The report as the user gets it: the title, the date and source count, a summary up top, dot's
// body, and the sources it cites, numbered in the order the text first cites them, each with the
// passages dot used. Every text passes through clean (secrets masked) first.
export function buildReport(
  draft: ReportDraft,
  clean: (text: string) => string = (text) => text,
): BuiltReport {
  const scrub = (text: string) => maskKeys(clean(text));
  const known = new Map(draft.sources.map((source) => [source.n, source]));
  const order = new Map<number, number>();
  const unknown = new Set<number>();
  const renumber = (text: string) =>
    prose(text, (part) =>
      part.replace(GROUP, (_whole, group: string) => {
        const numbers: number[] = [];
        for (const n of numbersIn(group)) {
          if (!known.has(n)) {
            unknown.add(n);
            continue;
          }
          if (!order.has(n)) order.set(n, order.size + 1);
          numbers.push(order.get(n) as number);
        }
        return numbers.length ? citation(numbers) : "";
      }),
    );
  const summary = renumber(scrub(draft.summary.trim()));
  const body = renumber(scrub(bodyOf(draft.body)));
  const cited = [...order.keys()];
  const title = oneLine(scrub(draft.title)) || "Research report";
  const lines = [
    `# ${title}`,
    "",
    `*${longDate(draft.date)} · ${cited.length} ${cited.length === 1 ? "source" : "sources"} cited*`,
    "",
    "## Summary",
    "",
    summary,
    "",
    body,
    "",
  ];
  if (cited.length) {
    lines.push("## Sources", "");
    cited.forEach((n, i) => {
      const source = known.get(n) as ReportSource;
      lines.push(
        `${i + 1}. [${linkText(oneLine(scrub(source.title)) || siteOf(source.url))}](<${source.url}>) · ${siteOf(source.url)}`,
      );
      for (const passage of source.passages) {
        const shown = oneLine(scrub(passage));
        const cut =
          [...shown].length > PASSAGE_SHOWN
            ? `${[...shown].slice(0, PASSAGE_SHOWN - 1).join("")}…`
            : shown;
        lines.push("", `   > “${cut}”`);
      }
      lines.push("");
    });
  }
  const also = draft.sources.filter((source) => !order.has(source.n));
  if (also.length) {
    lines.push("## Also read", "");
    for (const source of also)
      lines.push(
        `- [${linkText(oneLine(scrub(source.title)) || siteOf(source.url))}](<${source.url}>) · ${siteOf(source.url)}`,
      );
    lines.push("");
  }
  return {
    markdown: `${lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()}\n`,
    cited,
    unknown: [...unknown].sort((a, b) => a - b),
  };
}

// A file name for the report: lowercase words joined by hyphens, never starting with one.
export function reportName(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\.(?:md|pdf)$/, "")
    .match(/[a-z0-9]+/g);
  let slug = "";
  for (const word of words ?? []) {
    if (`${slug}-${word}`.length > 60) break;
    slug = slug ? `${slug}-${word}` : word;
  }
  return slug || "research-report";
}
