import { fileExtension } from "@localdot/protocol";

// Syntax colouring for the full preview: keywords, strings, numbers and comments in the code
// block's tints, tags and attributes in markup. A small single-pass tokenizer per family; anything
// it does not know stays plain text.
export type Tone = "keyword" | "string" | "number" | "comment" | "tag" | "attribute";
export interface Span {
  text: string;
  tone?: Tone;
}
type Family = "c" | "hash" | "python" | "sql" | "lua" | "markup" | "css" | "json" | "plain";
// What a line ends inside of, carried to the next line.
type Open = "block" | "markup-comment" | "triple-double" | "triple-single" | "template" | undefined;

const FAMILIES: Record<string, Family> = {
  ...Object.fromEntries(
    "js mjs cjs jsx ts tsx java kt kts swift c h cc cpp hpp cs go rs php dart scala"
      .split(" ")
      .map((e) => [e, "c" as const]),
  ),
  ...Object.fromEntries(
    "rb sh bash zsh fish ps1 pl r yaml yml toml ini cfg conf"
      .split(" ")
      .map((e) => [e, "hash" as const]),
  ),
  py: "python",
  sql: "sql",
  lua: "lua",
  ...Object.fromEntries(
    "html htm xml svg vue svelte".split(" ").map((e) => [e, "markup" as const]),
  ),
  css: "css",
  scss: "css",
  less: "css",
  json: "json",
};
export function family(name: string): Family {
  return FAMILIES[fileExtension(name)] ?? "plain";
}

const words = (text: string) => new Set(text.split(" "));
const KEYWORDS: Partial<Record<Family, Set<string>>> = {
  c: words(
    "abstract as async await break case catch class const continue default defer delete do else enum export extends false final finally fn for func function go if impl implements import in instanceof interface let match mod module mut namespace new nil null of override package private protected pub public readonly return self static struct super switch this throw throws true try type typeof undefined use var void when where while with yield",
  ),
  hash: words(
    "begin case do done elif else end esac fi for function if in local module require return then true false nil def class unless until while yes no null",
  ),
  python: words(
    "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield",
  ),
  sql: words(
    "add all alter and as asc between by case create delete desc distinct drop else end exists false from full group having if in index inner insert into is join key left like limit not null on or order outer primary references right select set table then true union unique update values view when where with",
  ),
  lua: words(
    "and break do else elseif end false for function goto if in local nil not or repeat return then true until while",
  ),
  css: words("important"),
  json: words("true false null"),
};
const NUMBER = /^(?:0x[0-9a-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/i;
const WORD = /^[A-Za-z_$][\w$]*/;

interface Rules {
  line?: string[];
  block?: [string, string];
  quotes: string;
}
const RULES: Record<Exclude<Family, "markup" | "plain">, Rules> = {
  c: { line: ["//"], block: ["/*", "*/"], quotes: "\"'`" },
  hash: { line: ["#"], quotes: "\"'" },
  python: { line: ["#"], quotes: "\"'" },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: "'\"" },
  lua: { line: ["--"], quotes: "\"'" },
  css: { block: ["/*", "*/"], quotes: "\"'" },
  json: { quotes: '"' },
};

// Each line's spans, in order; a comment or string left open runs on into the next lines.
export function highlight(lines: readonly string[], fam: Family): Span[][] {
  let open: Open;
  return lines.map((line) => {
    const spans: Span[] = [];
    if (fam === "plain") push(spans, line);
    else open = fam === "markup" ? markup(line, open, spans) : code(line, fam, open, spans);
    return spans;
  });
}

function push(spans: Span[], text: string, tone?: Tone): void {
  if (!text) return;
  const last = spans.at(-1);
  if (last && last.tone === tone) last.text += text;
  else spans.push(tone ? { text, tone } : { text });
}

function closeOf(open: Open): string {
  if (open === "block") return "*/";
  if (open === "triple-double") return '"""';
  if (open === "triple-single") return "'''";
  if (open === "template") return "`";
  return "-->";
}

function code(
  line: string,
  fam: Exclude<Family, "markup" | "plain">,
  open: Open,
  spans: Span[],
): Open {
  const rules = RULES[fam];
  const keywords = KEYWORDS[fam];
  let i = 0;
  if (open) {
    const end = line.indexOf(closeOf(open));
    const tone = open === "block" ? "comment" : "string";
    if (end < 0) {
      push(spans, line, tone);
      return open;
    }
    i = end + closeOf(open).length;
    push(spans, line.slice(0, i), tone);
  }
  let plain = "";
  const flush = () => {
    push(spans, plain);
    plain = "";
  };
  while (i < line.length) {
    const rest = line.slice(i);
    const ch = line[i] as string;
    if (rules.line?.some((p) => rest.startsWith(p))) {
      flush();
      push(spans, rest, "comment");
      return undefined;
    }
    if (rules.block && rest.startsWith(rules.block[0])) {
      flush();
      const end = line.indexOf(rules.block[1], i + rules.block[0].length);
      if (end < 0) {
        push(spans, rest, "comment");
        return "block";
      }
      push(spans, line.slice(i, end + rules.block[1].length), "comment");
      i = end + rules.block[1].length;
      continue;
    }
    if (fam === "python" && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      flush();
      const quote = rest.slice(0, 3);
      const end = line.indexOf(quote, i + 3);
      if (end < 0) {
        push(spans, rest, "string");
        return quote === '"""' ? "triple-double" : "triple-single";
      }
      push(spans, line.slice(i, end + 3), "string");
      i = end + 3;
      continue;
    }
    if (rules.quotes.includes(ch)) {
      flush();
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      if (j >= line.length && ch === "`" && fam === "c") {
        push(spans, rest, "string");
        return "template";
      }
      const text = line.slice(i, Math.min(line.length, j + 1));
      // A JSON key reads as a name, its value as a string.
      const key = fam === "json" && /^\s*:/.test(line.slice(j + 1));
      push(spans, text, key ? "attribute" : "string");
      i += text.length;
      continue;
    }
    const before = line[i - 1] ?? " ";
    if (/[\d]/.test(ch) && !/[\w$]/.test(before)) {
      const number = NUMBER.exec(rest)?.[0];
      if (number) {
        flush();
        push(spans, number, "number");
        i += number.length;
        continue;
      }
    }
    if (/[A-Za-z_$@]/.test(ch) && !/[\w$]/.test(before)) {
      const word =
        (ch === "@" ? `@${WORD.exec(rest.slice(1))?.[0] ?? ""}` : WORD.exec(rest)?.[0]) ?? ch;
      const known =
        keywords?.has(fam === "sql" ? word.toLowerCase() : word) || (fam === "css" && ch === "@");
      if (known) {
        flush();
        push(spans, word, "keyword");
      } else plain += word;
      i += word.length;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return undefined;
}

function markup(line: string, open: Open, spans: Span[]): Open {
  let i = 0;
  if (open === "markup-comment") {
    const end = line.indexOf("-->");
    if (end < 0) {
      push(spans, line, "comment");
      return open;
    }
    push(spans, line.slice(0, end + 3), "comment");
    i = end + 3;
  }
  while (i < line.length) {
    const lt = line.indexOf("<", i);
    if (lt < 0) {
      push(spans, line.slice(i));
      return undefined;
    }
    push(spans, line.slice(i, lt));
    if (line.startsWith("<!--", lt)) {
      const end = line.indexOf("-->", lt + 4);
      if (end < 0) {
        push(spans, line.slice(lt), "comment");
        return "markup-comment";
      }
      push(spans, line.slice(lt, end + 3), "comment");
      i = end + 3;
      continue;
    }
    const name = /^<\/?[!?]?[\w:.-]*/.exec(line.slice(lt))?.[0] ?? "<";
    push(spans, name, "tag");
    i = lt + name.length;
    // Attributes up to the tag's end on this line.
    while (i < line.length && line[i] !== ">") {
      const rest = line.slice(i);
      const attribute = /^[^\s=>"'/]+/.exec(rest)?.[0];
      if (attribute) {
        push(spans, attribute, "attribute");
        i += attribute.length;
        continue;
      }
      const quote = rest[0];
      if (quote === '"' || quote === "'") {
        const end = line.indexOf(quote, i + 1);
        const text = line.slice(i, end < 0 ? line.length : end + 1);
        push(spans, text, "string");
        i += text.length;
        continue;
      }
      push(spans, rest[0] === "/" ? "/" : (rest[0] as string), rest[0] === "/" ? "tag" : undefined);
      i++;
    }
    if (line[i] === ">") {
      push(spans, ">", "tag");
      i++;
    }
  }
  return undefined;
}
