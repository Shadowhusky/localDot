import type { SearchHit } from "./engines.ts";

// Words that say nothing about what is pictured: grammar, the kind of file, and the names of
// languages, which junk pages share with a query through phrases like "… in English".
const STOP = new Set(
  [
    "a an the and or of in on at to for with without by from as is are be it its this that these",
    "those how what which who why where when vs via into over under near about my your our their",
    "image images picture pictures photo photos photograph pic pics png jpg jpeg gif hd 4k stock",
    "free download english british american french german spanish italian chinese japanese korean",
    "russian portuguese dutch de la le les des du el los las et y en un una une der die das und",
    "von il di",
  ]
    .join(" ")
    .split(" "),
);
const STOP_PAIRS = new Set("图片 圖片 照片 图像 圖像 高清 素材 画像 写真 사진".split(" "));

// Scripts written without spaces between words, or with particles joined to them.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC]+/gu;
// Search operators, and words the query asks to leave out.
const OPERATOR = /(?:^|\s)(?:-\S+|[a-z]+:\S+)/gi;
const segmenter = new Intl.Segmenter("en", { granularity: "word" });

// Underscores join words in addresses, and would join them as one word here.
const normal = (text: string) => text.normalize("NFKC").toLowerCase().replaceAll("_", " ");

// A word without its accents and its plural ending, so "Coffers" matches "coffer".
const fold = (word: string) =>
  word
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/'s$/, "")
    .replace(/(?<=\p{L}{2}(?:ss|x|z|ch|sh))es$/u, "")
    .replace(/(?<=\p{L}{3}[^s])s$/u, "");

function words(text: string): string[] {
  const out: string[] = [];
  for (const { segment, isWordLike } of segmenter.segment(text.replace(UNSPACED, " ")))
    if (isWordLike && [...segment].length > 1) out.push(fold(segment));
  return out;
}

// Unspaced writing is matched by pairs of characters, which need no dictionary of its words.
function pairs(text: string): string[] {
  return (text.match(UNSPACED) ?? []).flatMap((run) => {
    const chars = [...run];
    return chars.length === 1 ? [run] : chars.slice(1).map((char, i) => chars[i] + char);
  });
}

function decoded(url: string | undefined): string {
  if (!url) return "";
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

export interface QueryTerms {
  readonly words: readonly string[];
  readonly pairs: readonly string[];
}

// What a query is about: its words and character pairs, less those about nothing.
export function queryTerms(query: string): QueryTerms {
  const text = normal(query).replace(OPERATOR, " ");
  return {
    words: [...new Set(words(text).filter((word) => !STOP.has(word)))],
    pairs: [...new Set(pairs(text).filter((pair) => !STOP_PAIRS.has(pair)))],
  };
}

// An image result is about the query when its title, its page or its picture's address shares a
// term with it, and two with a query of four terms or more: a page Bing fills with pictures it
// shows anyone, or that match a single common word, shares fewer. A query of only words about
// nothing keeps every result.
export function relevantTo(query: string): (hit: SearchHit) => boolean {
  const terms = queryTerms(query);
  const count = terms.words.length + terms.pairs.length;
  const need = count >= 4 ? 2 : 1;
  return (hit) => {
    if (!count) return true;
    const text = normal([hit.title, hit.snippet, decoded(hit.url), decoded(hit.image)].join(" "));
    const own = new Set(words(text));
    const shared =
      terms.words.filter((word) => own.has(word)).length +
      terms.pairs.filter((pair) => text.includes(pair)).length;
    return shared >= need;
  };
}
