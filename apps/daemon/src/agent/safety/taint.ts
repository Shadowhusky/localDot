import { createHash } from "node:crypto";
import { type TaintKind, TaintSource } from "@localdot/protocol";

const MAX_SOURCES = 64;
const ORIGIN_MAX = 200;
const MAX_PRINTS = 200_000;
const SHINGLE = 3;
// Of an outbound text's word triples, the share already seen in private text that counts as
// carrying it.
const OVERLAP_SHARE = 0.25;

export interface Overlap {
  readonly overlaps: boolean;
  readonly score: number;
}

function words(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}@._+-]+/gu) ?? []
  );
}

// A word worth matching on its own: an address, a number or a long name.
function distinctive(word: string): boolean {
  return word.length >= 5 && (/[\d@]/.test(word) || word.length >= 12);
}

function print(text: string): string {
  return createHash("sha256").update(text).digest("base64url").slice(0, 16);
}

// An origin as the journal can hold it: one line of whole characters, at most 200 code units.
function shown(origin: string): string {
  let kept = "";
  for (const char of origin
    .toWellFormed()
    .replace(/\p{Cc}+/gu, " ")
    .trim()) {
    if (kept.length + char.length > ORIGIN_MAX) break;
    kept += char;
  }
  return kept;
}

// What private data the task has read: where it came from, and hashed fingerprints of its text
// to tell whether outbound text carries it. The text itself is never kept.
export class TaskTaint {
  readonly #sources = new Map<string, TaintSource>();
  readonly #prints = new Set<string>();
  constructor(private readonly recorded: (source: TaintSource) => void = () => {}) {}
  get tainted(): boolean {
    return this.#sources.size > 0;
  }
  get sources(): readonly TaintSource[] {
    return [...this.#sources.values()];
  }
  get kinds(): readonly TaintKind[] {
    return [...new Set(this.sources.map((source) => source.kind))];
  }
  origins(kind: TaintKind): readonly string[] {
    return this.sources.filter((source) => source.kind === kind).map((source) => source.origin);
  }
  add(kind: TaintKind, origin: string, text?: string): void {
    const source = TaintSource.parse({ kind, origin: shown(origin) || kind });
    const key = `${source.kind}\n${source.origin}`;
    if (!this.#sources.has(key) && this.#sources.size < MAX_SOURCES) {
      this.#sources.set(key, source);
      this.recorded(source);
    }
    if (text) this.#remember(text);
  }
  #remember(text: string): void {
    const all = words(text);
    const add = (value: string) => {
      if (this.#prints.size < MAX_PRINTS) this.#prints.add(print(value));
    };
    for (const word of all) if (distinctive(word)) add(word);
    for (let i = 0; i + SHINGLE <= all.length; i++) add(all.slice(i, i + SHINGLE).join(" "));
  }
  overlap(text: string): Overlap {
    const all = words(text);
    if (all.some((word) => distinctive(word) && this.#prints.has(print(word))))
      return { overlaps: true, score: 1 };
    const shingles = all.length - SHINGLE + 1;
    if (shingles < 1) return { overlaps: false, score: 0 };
    let seen = 0;
    for (let i = 0; i < shingles; i++)
      if (this.#prints.has(print(all.slice(i, i + SHINGLE).join(" ")))) seen++;
    const score = seen / shingles;
    return { overlaps: score >= OVERLAP_SHARE, score };
  }
}

// Memory reaches every task's model; what it holds beyond its headings is private.
export function taintMemory(taint: TaskTaint, memory: { user: string; memory: string }): void {
  for (const [origin, text] of [
    ["USER.md", memory.user],
    ["MEMORY.md", memory.memory],
  ] as const)
    if (text.replace(/^#.*$/gm, "").trim()) taint.add("memory", origin, text);
}
