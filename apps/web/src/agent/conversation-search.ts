import {
  type ConversationEntry,
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type SearchHit,
} from "@localdot/protocol";
import { useMemo } from "react";
import type { ApiClient } from "../lib/api.ts";
import { useTaskSearch } from "../replay/search-api.ts";
import type { ConversationRow } from "./conversation-list.ts";

export interface ConversationMatch {
  row: ConversationRow;
  // The title with the words that match marked (SEARCH_MARK_START … SEARCH_MARK_END).
  title: string;
  // Why it matched when its title doesn't say: what was first asked in it, or what one of its tasks
  // said, marked the same way.
  snippet?: string;
}

interface Word {
  start: number;
  text: string;
}

// A text folded for matching, case and accents aside, with where each folded character came from.
interface Folded {
  source: string;
  words: Word[];
  from: number[];
}

const WORD = /[\p{L}\p{N}]+/gu;
const MARKS = /[]/g;
const MAX_TERMS = 8;

function fold(text: string): Folded {
  const source = text.replace(MARKS, "");
  let folded = "";
  const from: number[] = [];
  for (let at = 0; at < source.length; ) {
    const char = String.fromCodePoint(source.codePointAt(at) ?? 0);
    const plain = char.toLocaleLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
    for (let unit = 0; unit < plain.length; unit++) from.push(at);
    folded += plain;
    at += char.length;
  }
  from.push(source.length);
  const words = [...folded.matchAll(WORD)].map((match) => ({
    start: match.index,
    text: match[0],
  }));
  return { source, words, from };
}

// How far a term is from the nearest start of a word, in edits (a swap of two letters is one), up
// to `max`; more than `max` when none is that close. Typos in the first letter are rare, so it must
// match.
function prefixDistance(term: string, word: string, max: number): number {
  if (term[0] !== word[0]) return max + 1;
  const columns = Math.min(word.length, term.length + max);
  let before: number[] = [];
  let previous = Array.from({ length: columns + 1 }, (_, column) => column);
  for (let row = 1; row <= term.length; row++) {
    const current = [row];
    for (let column = 1; column <= columns; column++) {
      const same = term[row - 1] === word[column - 1] ? 0 : 1;
      let best = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + same,
      );
      if (
        row > 1 &&
        column > 1 &&
        term[row - 1] === word[column - 2] &&
        term[row - 2] === word[column - 1]
      )
        best = Math.min(best, (before[column - 2] ?? 0) + 1);
      current.push(best);
    }
    if (Math.min(...current) > max) return max + 1;
    before = previous;
    previous = current;
  }
  return Math.min(...previous);
}

interface Hit {
  // 4 the start of the text, 3 the start of a word, 2 inside one, 1 a word near it.
  score: number;
  start: number;
  end: number;
}

function findTerm(term: string, folded: Folded): Hit | undefined {
  let best: Hit | undefined;
  const keep = (hit: Hit) => {
    if (!best || hit.score > best.score) best = hit;
  };
  const typos = term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0;
  for (const [index, word] of folded.words.entries()) {
    if (word.text.startsWith(term))
      keep({ score: index === 0 ? 4 : 3, start: word.start, end: word.start + term.length });
    else if (term.length >= 2 && word.text.includes(term)) {
      const start = word.start + word.text.indexOf(term);
      keep({ score: 2, start, end: start + term.length });
    } else if (typos && prefixDistance(term, word.text, typos) <= typos)
      keep({ score: 1, start: word.start, end: word.start + word.text.length });
  }
  return best;
}

// The source with the hits marked, as a snippet is.
function mark(folded: Folded, hits: readonly Hit[]): string {
  const ranges = hits
    .map((hit) => [folded.from[hit.start] ?? 0, folded.from[hit.end] ?? folded.source.length])
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  let out = "";
  let at = 0;
  for (const [start = 0, end = 0] of ranges) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    out += `${folded.source.slice(at, from)}${SEARCH_MARK_START}${folded.source.slice(from, end)}${SEARCH_MARK_END}`;
    at = end;
  }
  return out + folded.source.slice(at);
}

const prepared = new WeakMap<ConversationEntry, { title: Folded; said: Folded | null }>();
function foldedOf(row: ConversationRow) {
  let kept = prepared.get(row.entry);
  if (!kept || kept.title.source !== row.title) {
    kept = { title: fold(row.title), said: row.entry.said ? fold(row.entry.said) : null };
    prepared.set(row.entry, kept);
  }
  return kept;
}

export const searchWords = (query: string) =>
  [...query.toLocaleLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").matchAll(WORD)]
    .map((match) => match[0])
    .slice(0, MAX_TERMS);

// The conversations a search finds, best first: those whose every word is in the title, the word
// starting a word ranking above one inside a word or a word with a typo, then those the first
// message completes, then those the search index found in what their tasks said, as it ranks them.
// Ties keep the list's order. `found` holds the index's best hit for each task.
export function searchConversations(
  rows: readonly ConversationRow[],
  query: string,
  found: ReadonlyMap<string, SearchHit> = new Map(),
): ConversationMatch[] {
  const terms = searchWords(query);
  if (!terms.length) return [];
  const ranks = new Map([...found.keys()].map((id, rank) => [id, rank]));
  const scored: { match: ConversationMatch; tier: number; score: number; order: number }[] = [];
  for (const [order, row] of rows.entries()) {
    const { title, said } = foldedOf(row);
    const inTitle = terms.map((term) => findTerm(term, title));
    const titleHits = inTitle.filter((hit): hit is Hit => !!hit);
    const marked = mark(title, titleHits);
    if (titleHits.length === terms.length) {
      const score = titleHits.reduce((sum, hit) => sum + hit.score, 0);
      scored.push({ match: { row, title: marked }, tier: 0, score, order });
      continue;
    }
    const inSaid = said
      ? terms.map((term, index) => (inTitle[index] ? undefined : findTerm(term, said)))
      : [];
    if (said && terms.every((_, index) => inTitle[index] || inSaid[index])) {
      const saidHits = inSaid.filter((hit): hit is Hit => !!hit);
      const score = [...titleHits, ...saidHits].reduce((sum, hit) => sum + hit.score, 0);
      scored.push({
        match: { row, title: marked, snippet: mark(said, saidHits) },
        tier: 1,
        score,
        order,
      });
      continue;
    }
    const task = row.entry.sessions
      .filter((id) => ranks.has(id))
      .sort((a, b) => (ranks.get(a) ?? 0) - (ranks.get(b) ?? 0))[0];
    const hit = task ? found.get(task) : undefined;
    if (task && hit)
      scored.push({
        match: { row, title: marked, snippet: hit.snippet },
        tier: 2,
        score: -(ranks.get(task) ?? 0),
        order,
      });
  }
  return scored
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.order - b.order)
    .map((each) => each.match);
}

// The conversations among these rows that match, as the user types: titles and first messages at
// once, what their tasks said once typing pauses. Null while there is no search.
export function useConversationSearch(
  api: ApiClient,
  rows: readonly ConversationRow[],
  query: string,
): { matches: ConversationMatch[] | null; pending: boolean } {
  const content = useTaskSearch(api, query);
  const matches = useMemo(
    () => (query.trim() ? searchConversations(rows, query, content.tasks) : null),
    [rows, query, content.tasks],
  );
  return { matches, pending: content.pending };
}
