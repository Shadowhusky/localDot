export type Lang = "zh" | "en" | "ja";

// Without the katakana middle dot (U+30FB), which Chinese also writes between the parts of a name.
const KANA = /[\u{3040}-\u{30fa}\u{30fc}-\u{30ff}\u{31f0}-\u{31ff}\u{ff66}-\u{ff9f}]/u;
export const HAN = /[\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{f900}-\u{faff}]/u;
export const CJK = new RegExp(`${KANA.source}|${HAN.source}`, "u");
const LATIN = /[A-Za-z]/;
// Common characters only Chinese writes: none is a JIS X 0208 kanji.
const CHINESE_ONLY = new Set(
  "这们说么吗呢吧时对过还为发现进动种样经问题认你她哪啊给让谁记讲话语请谢东车门见长头买卖实习边" +
    "难欢乐爱电脑开关应该业产书带视亲远运选连钱错饭鱼鸟马觉识读试设计论处张总间闻报战结变传红办转" +
    "满单专观虽兴线别两帮极离终您",
);

const count = (text: string, pattern: RegExp) => [...text].filter((ch) => pattern.test(ch)).length;

// One Han character carries about a word, so it outweighs three Latin letters. Japanese written
// only in kanji looks Chinese, so the reply's language decides that case, unless the text holds a
// character only Chinese writes.
export function detectLang(text: string, hint?: Lang): Lang {
  if (count(text, KANA) > 0) return "ja";
  const han = count(text, HAN);
  const latin = count(text, LATIN);
  if (han > 0 && han * 3 >= latin) {
    return hint === "ja" && ![...text].some((ch) => CHINESE_ONLY.has(ch)) ? "ja" : "zh";
  }
  if (latin > 0) return "en";
  return hint ?? "en";
}

// A whole reply's language, the hint for its sentences: its dominant script. Kana must make up a
// quarter of its CJK characters, so one title in kana leaves a Chinese reply Chinese.
export function replyLang(text: string): Lang {
  const kana = count(text, KANA);
  const cjk = kana + count(text, HAN);
  if (cjk > 0 && cjk * 3 >= count(text, LATIN)) return kana * 4 >= cjk ? "ja" : "zh";
  return "en";
}
