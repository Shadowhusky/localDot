// The messages a source file asks for, as the catalog keys them: what t`…` and rich`…` are written
// with ({0} for each value), tr("…"), and the "one|other" pair of a count or plural. Read from the
// text, as the app is never run to find them; a message built some other way can't be translated.

const ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  0: "\0",
};

// Past a string or template that starts at `at`, returning where it ends.
function skipQuoted(text: string, at: number): number {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && char === "$" && text[i + 1] === "{") {
      i = skipExpression(text, i + 2);
      continue;
    }
    if (char === quote) return i + 1;
    i++;
  }
  return i;
}

// Past an expression that starts at `at` and ends at its own closing brace.
function skipExpression(text: string, at: number): number {
  let depth = 1;
  let i = at;
  while (i < text.length && depth > 0) {
    const char = text[i];
    if (char === '"' || char === "'" || char === "`") {
      i = skipQuoted(text, i);
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    i++;
  }
  return i;
}

function cooked(raw: string): string {
  return raw.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs,
    (_, code: string) => {
      if (code.startsWith("u{"))
        return String.fromCodePoint(Number.parseInt(code.slice(2, -1), 16));
      if (code.length > 1 && (code[0] === "u" || code[0] === "x"))
        return String.fromCharCode(Number.parseInt(code.slice(1), 16));
      return ESCAPES[code] ?? code;
    },
  );
}

// The key of the template whose opening backtick is at `at`.
function templateKey(text: string, at: number): string {
  let key = "";
  let raw = "";
  let values = 0;
  let i = at + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === "\\") {
      raw += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === "$" && text[i + 1] === "{") {
      key += `${cooked(raw)}{${values++}}`;
      raw = "";
      i = skipExpression(text, i + 2);
      continue;
    }
    if (char === "`") break;
    raw += char;
    i++;
  }
  return key + cooked(raw);
}

function stringAt(text: string, at: number): string | undefined {
  const quote = text[at];
  if (quote !== '"' && quote !== "'") return undefined;
  const end = skipQuoted(text, at);
  return cooked(text.slice(at + 1, end - 1));
}

// The arguments of a call whose opening parenthesis is at `at`, as source text.
function callArguments(text: string, at: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = at + 1;
  let i = at + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === '"' || char === "'" || char === "`") {
      i = skipQuoted(text, i);
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args;
      }
      depth--;
    } else if (char === "," && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  return args;
}

const literal = (arg: string | undefined) =>
  arg && /^(["'])(?:\\.|(?!\1).)*\1$/s.test(arg) ? stringAt(arg, 0) : undefined;

// The source with its comments blanked, strings and templates left as they are.
function withoutComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"' || char === "'" || char === "`") {
      const end = skipQuoted(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (char === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

export function messagesIn(source: string): string[] {
  const text = withoutComments(source);
  const found: string[] = [];
  for (const match of text.matchAll(/(?<![\w$.])(?:t|rich)`/g))
    found.push(templateKey(text, (match.index ?? 0) + match[0].length - 1));
  for (const match of text.matchAll(/(?<![\w$.])tr\(\s*/g)) {
    const key = stringAt(text, (match.index ?? 0) + match[0].length);
    if (key !== undefined) found.push(key);
  }
  for (const match of text.matchAll(/(?<![\w$.])(?:count|plural)\(/g)) {
    const args = callArguments(text, (match.index ?? 0) + match[0].length - 1);
    const one = literal(args[1]);
    const other = literal(args[2]);
    if (one !== undefined && other !== undefined) found.push(`${one}|${other}`);
  }
  return found;
}
