export type Lang = "zh" | "en" | "ja";

// Without the katakana middle dot (U+30FB), which Chinese also writes between the parts of a name.
const KANA = /[\u{3040}-\u{30fa}\u{30fc}-\u{30ff}\u{31f0}-\u{31ff}\u{ff66}-\u{ff9f}]/u;
export const HAN = /[\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{f900}-\u{faff}]/u;
export const CJK = new RegExp(`${KANA.source}|${HAN.source}`, "u");
const LATIN = /[A-Za-z]/;

const count = (text: string, pattern: RegExp) => [...text].filter((ch) => pattern.test(ch)).length;

// One Han character carries about a word, so it outweighs three Latin letters. Japanese written
// only in kanji looks Chinese, so the reply's language decides that case.
export function detectLang(text: string, hint?: Lang): Lang {
  if (count(text, KANA) > 0) return "ja";
  const han = count(text, HAN);
  const latin = count(text, LATIN);
  if (han > 0 && han * 3 >= latin) return hint === "ja" ? "ja" : "zh";
  if (latin > 0) return "en";
  return hint ?? "en";
}
