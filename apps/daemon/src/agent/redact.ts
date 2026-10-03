const SURROGATE_ANYWHERE = /ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}/g;
export const REDACTED = "[redacted]";
type Chunk = { stream: "stdout" | "stderr"; chunk: string };
export type Redactor = ((text: string) => string) & {
  stream?: () => { push(chunk: Chunk): Chunk[]; finish(): Chunk[] };
};
export function redactor(secrets: Iterable<string | undefined>): Redactor {
  const known = [
    ...new Set([...secrets].filter((s): s is string => typeof s === "string" && s.length >= 8)),
  ].sort((a, b) => b.length - a.length);
  const redact: Redactor = (text) => {
    let out = text.replace(SURROGATE_ANYWHERE, REDACTED);
    for (const secret of known) out = out.split(secret).join(REDACTED);
    return out;
  };
  redact.stream = () => {
    let pending: Chunk[] = [];
    const hold = Math.max(46, ...known.map((s) => s.length));
    const drain = (final: boolean): Chunk[] => {
      const raw = pending.map((c) => c.chunk).join("");
      const spans: { start: number; end: number }[] = [];
      for (const m of raw.matchAll(SURROGATE_ANYWHERE))
        spans.push({ start: m.index, end: m.index + m[0].length });
      for (const secret of known) {
        let at = raw.indexOf(secret);
        while (at !== -1) {
          spans.push({ start: at, end: at + secret.length });
          at = raw.indexOf(secret, at + 1);
        }
      }
      spans.sort((a, b) => a.start - b.start || b.end - a.end);
      const merged: typeof spans = [];
      for (const span of spans) {
        const last = merged.at(-1);
        if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
        else merged.push({ ...span });
      }
      let cut = final ? raw.length : Math.max(0, raw.length - hold);
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
