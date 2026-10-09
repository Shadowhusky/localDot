export const START = "\uE000";
export const END = "\uE001";

// Words only: quotes, operators and punctuation never reach FTS5's query syntax.
export function searchTerms(raw: string): string[] {
  return [
    ...raw
      .normalize("NFKC")
      .toLowerCase()
      .matchAll(/[\p{L}\p{N}]+/gu),
  ]
    .map((m) => m[0].slice(0, 64))
    .slice(0, 8);
}
export const ftsMatch = (terms: readonly string[]) => terms.map((t) => `"${t}"*`).join(" ");
export const hasCjk = (s: string) =>
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);
export function likeSnippet(text: string, terms: readonly string[]): string {
  const lower = text.toLowerCase();
  const term = terms.find((t) => lower.includes(t)) ?? "";
  const at = term ? lower.indexOf(term) : 0;
  const from = Math.max(0, at - 60);
  const to = Math.min(text.length, at + term.length + 60);
  return `${from > 0 ? "…" : ""}${text.slice(from, at)}${START}${text.slice(at, at + term.length)}${END}${text.slice(at + term.length, to)}${to < text.length ? "…" : ""}`.replace(
    `${START}${END}`,
    "",
  );
}
export const escapeLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);
export function clipSnippet(s: string, max = 400): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 2);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  if (cut.lastIndexOf(START) > cut.lastIndexOf(END)) cut += END;
  return `${cut}…`;
}
