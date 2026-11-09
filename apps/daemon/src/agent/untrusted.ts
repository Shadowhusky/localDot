// Text that came from the computer (web pages, files, command output) reaches the model inside an
// <untrusted> block, and the system prompt says such text is data, never instructions (Review
// Focus 1). The text cannot close the block early: every tag that reads as "<untrusted" or
// "</untrusted" is defused first, whatever its case or spacing, and whether it is written with a
// look-alike bracket, slash or letters (full-width, small, angle, modifier) or with invisible
// characters or marks inside. A defused tag starts with "[", which nothing reads as a tag.
const OPEN = /[<\uFF1C\uFE64\u2039\u3008\u27E8\u2329\u02C2\u1438]/g;
const SLASH = /[/\uFF0F\u2044\u2215\u29F8]/y;
const GAP = /[\s\p{Cf}\p{Mn}]*/uy;
const WORD = /[\p{L}\p{Cf}\p{Mn}]{0,40}/uy;

// Where a sticky pattern's match from `at` ends. Each pattern is one character class, so it never
// backtracks: a tag is read in time linear in the text, whatever follows a bracket.
function past(pattern: RegExp, text: string, at: number): number {
  pattern.lastIndex = at;
  return pattern.exec(text) ? pattern.lastIndex : at;
}

export function untrusted(source: string, text: string): string {
  const safeSource = source.replace(/["<>\n\r]/g, " ").slice(0, 300);
  let body = "";
  let from = 0;
  OPEN.lastIndex = 0;
  for (let found = OPEN.exec(text); found; found = OPEN.exec(text)) {
    let at = past(GAP, text, found.index + 1);
    const slash = past(SLASH, text, at) > at;
    if (slash) at = past(GAP, text, at + 1);
    const end = past(WORD, text, at);
    const read = text
      .slice(at, end)
      .replace(/[\p{Cf}\p{Mn}]/gu, "")
      .normalize("NFKC")
      .toLowerCase();
    if (!read.startsWith("untrusted")) continue;
    body += `${text.slice(from, found.index)}[${slash ? "/" : ""}${read}`;
    from = end;
    OPEN.lastIndex = end;
  }
  return `<untrusted source="${safeSource}">\n${body}${text.slice(from)}\n</untrusted>`;
}
