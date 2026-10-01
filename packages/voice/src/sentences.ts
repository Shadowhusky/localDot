import { CJK } from "./lang.ts";

const SENTENCE_END = new Set(["。", "！", "？", "!", "?", "…", "\n"]);
const CLAUSE_END = new Set(["，", "、", ",", ";", "；", "：", ":"]);
const CLOSERS = new Set(["”", "’", "」", "』", "）", ")", '"', "'", "]", "】"]);
const SPEAKABLE = /[\p{L}\p{N}]/u;

export const FIRST_MIN_UNITS = 4;
export const MAX_UNITS = 160;

// Speech length: a CJK character is about two Latin letters of speaking time.
export function speechUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    units += CJK.test(ch) ? 2 : 1;
  }
  return units;
}

export class SentenceSplitter {
  #buffer = "";
  #first = true;

  push(delta: string): string[] {
    this.#buffer += delta;
    const out: string[] = [];
    for (let cut = this.#nextCut(); cut > 0; cut = this.#nextCut()) {
      this.#emit(this.#buffer.slice(0, cut), out);
      this.#buffer = this.#buffer.slice(cut);
    }
    return out;
  }

  flush(): string[] {
    const out: string[] = [];
    this.#emit(this.#buffer, out);
    this.#buffer = "";
    this.#first = true;
    return out;
  }

  #emit(piece: string, out: string[]): void {
    const text = piece.trim();
    if (!SPEAKABLE.test(text)) return;
    out.push(text);
    this.#first = false;
  }

  // Index just past the next boundary, or 0 while the buffer must wait for more text.
  #nextCut(): number {
    const text = this.#buffer;
    let units = 0;
    let lastClause = 0;
    let lastSpace = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;
      const next = text[i + 1];
      if (SENTENCE_END.has(ch) || (ch === "." && next !== undefined && /\s/.test(next))) {
        return withClosers(text, i + 1);
      }
      if (/\s/.test(ch)) {
        lastSpace = i + 1;
        continue;
      }
      units += CJK.test(ch) ? 2 : 1;
      if (CLAUSE_END.has(ch)) {
        if (this.#first && units >= FIRST_MIN_UNITS) return withClosers(text, i + 1);
        lastClause = i + 1;
      }
      if (units > MAX_UNITS) return lastClause || lastSpace || i;
    }
    return 0;
  }
}

// A boundary at the very end of the buffer waits for one more character: a closing quote streamed
// in the next delta still belongs to the sentence.
function withClosers(text: string, end: number): number {
  let cut = end;
  while (cut < text.length && CLOSERS.has(text[cut] as string)) cut++;
  return cut < text.length ? cut : 0;
}
