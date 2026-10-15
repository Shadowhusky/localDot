import { keyLikeMatches } from "@localdot/protocol";

const SURROGATE_ANYWHERE = /ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}/g;
// A private key block, whole; one cut short ends where its key lines do. A key's lines are base64,
// headers and line breaks, escaped ones included, and no key is longer than 32 KiB; its first line
// fits in what a stream holds back.
const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]{0,10}PRIVATE KEY(?: BLOCK)?-----(?:[A-Za-z0-9+/=:,\s\\-]{0,32768}?-----END [A-Z0-9 ]{0,10}PRIVATE KEY(?: BLOCK)?-----|[A-Za-z0-9+/=:,\s\\-]{0,32768})/g;
const HOLD = 46;
const KEY_CHAR = /[A-Za-z0-9_.-]/;
// A shorter secret, such as a six-digit code, is masked only where it stands on its own.
const WORD = 8;
const WORD_CHAR = /[A-Za-z0-9]/;
export const REDACTED = "[redacted]";
type Chunk = { stream: "stdout" | "stderr"; chunk: string };
type Span = { start: number; end: number };
export type Redactor = ((text: string) => string) & {
  stream?: () => { push(chunk: Chunk): Chunk[]; finish(): Chunk[] };
};

const delivered = new WeakMap<object, Set<string>>();
// A password or code typed for a task stays out of everything that task shows from then on.
export function addTaskSecret(task: object, secret: string): void {
  if (secret.length < 4 || !secret.trim() || REDACTED.includes(secret)) return;
  const secrets = delivered.get(task) ?? new Set<string>();
  secrets.add(secret);
  delivered.set(task, secrets);
}

// Where a stream's last run of key characters starts. It may still grow into a key, so it waits
// until it is longer than the longest shortest key shape, the 67-character AQ. form.
function tailStart(raw: string): number {
  let start = raw.length;
  while (start > 0 && KEY_CHAR.test(raw[start - 1] ?? "")) {
    start -= 1;
    if (raw.length - start > 67) return raw.length;
  }
  return start;
}

function spansOf(raw: string, known: readonly string[]): Span[] {
  const spans: Span[] = [];
  for (const pattern of [SURROGATE_ANYWHERE, PRIVATE_KEY])
    for (const m of raw.matchAll(pattern))
      spans.push({ start: m.index, end: m.index + m[0].length });
  for (const m of keyLikeMatches(raw)) spans.push({ start: m.start, end: m.end });
  for (const secret of known)
    for (let at = raw.indexOf(secret); at !== -1; at = raw.indexOf(secret, at + 1)) {
      const end = at + secret.length;
      if (
        secret.length >= WORD ||
        (!WORD_CHAR.test(raw[at - 1] ?? "") && !WORD_CHAR.test(raw[end] ?? ""))
      )
        spans.push({ start: at, end });
    }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

// `task`: whose delivered secrets to mask too, including any delivered after this was made.
export function redactor(secrets: Iterable<string | undefined>, task?: object): Redactor {
  const fixed = [
    ...new Set([...secrets].filter((s): s is string => typeof s === "string" && s.length >= 8)),
  ];
  const known = () => [...fixed, ...((task && delivered.get(task)) ?? [])];
  const redact: Redactor = (text) => {
    let out = "",
      at = 0;
    for (const span of spansOf(text, known())) {
      out += text.slice(at, span.start) + REDACTED;
      at = span.end;
    }
    return out + text.slice(at);
  };
  redact.stream = () => {
    let pending: Chunk[] = [];
    const drain = (final: boolean): Chunk[] => {
      const raw = pending.map((c) => c.chunk).join("");
      const secrets = known();
      const merged = spansOf(raw, secrets);
      const hold = Math.max(HOLD, ...secrets.map((s) => s.length));
      let cut = final ? raw.length : Math.min(Math.max(0, raw.length - hold), tailStart(raw));
      for (const span of merged) if (span.start < cut && span.end > cut) cut = span.start;
      // Do not emit half a Unicode scalar: downstream byte-tail encoding cannot reconstruct it.
      if (
        cut > 0 &&
        cut < raw.length &&
        /[\uD800-\uDBFF]/u.test(raw[cut - 1] ?? "") &&
        /[\uDC00-\uDFFF]/u.test(raw[cut] ?? "")
      )
        cut -= 1;
      const output: Chunk[] = [];
      const emit = (stream: Chunk["stream"], chunk: string) => {
        if (!chunk) return;
        const last = output.at(-1);
        if (last?.stream === stream) last.chunk += chunk;
        else output.push({ stream, chunk });
      };
      const segment = (start: number, end: number) => {
        let at = 0;
        for (const part of pending) {
          const from = Math.max(start, at),
            to = Math.min(end, at + part.chunk.length);
          if (to > from) emit(part.stream, part.chunk.slice(from - at, to - at));
          at += part.chunk.length;
        }
      };
      const streamAt = (position: number) => {
        let at = 0;
        for (const part of pending) {
          if (position < at + part.chunk.length) return part.stream;
          at += part.chunk.length;
        }
        return "stdout" as const;
      };
      let at = 0;
      for (const span of merged) {
        if (span.end > cut) break;
        segment(at, span.start);
        emit(streamAt(span.start), REDACTED);
        at = span.end;
      }
      segment(at, cut);
      let remove = cut;
      pending = pending.flatMap((part) => {
        const n = Math.min(remove, part.chunk.length);
        remove -= n;
        return n === part.chunk.length ? [] : [{ ...part, chunk: part.chunk.slice(n) }];
      });
      return output;
    };
    return {
      push(chunk) {
        const last = pending.at(-1);
        if (last?.stream === chunk.stream) last.chunk += chunk.chunk;
        else pending.push({ ...chunk });
        return drain(false);
      },
      finish() {
        return drain(true);
      },
    };
  };
  return redact;
}
