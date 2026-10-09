// Spoken words go where the caret is, replacing a selection, with a space on each side where the
// words need one and none in Chinese or Japanese.
export interface Draft {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;
const OPENS = /[\s([{"'“‘]/;
const CLOSES = /[\s.,!?;:)\]}"'”’]/;

export function spoken(draft: Draft, words: string): { value: string; caret: number } {
  const text = words.trim();
  if (!text) return { value: draft.value, caret: draft.end };
  const before = draft.value.slice(0, draft.start);
  const after = draft.value.slice(draft.end);
  const last = before.at(-1) ?? "";
  const next = after[0] ?? "";
  const lead =
    last && !OPENS.test(last) && !(WIDE.test(last) || WIDE.test(text[0] ?? "")) ? " " : "";
  const trail =
    next && !CLOSES.test(next) && !(WIDE.test(next) || WIDE.test(text.at(-1) ?? "")) ? " " : "";
  const inserted = lead + text + trail;
  return { value: before + inserted + after, caret: before.length + lead.length + text.length };
}
