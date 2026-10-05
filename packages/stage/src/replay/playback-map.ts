// packages/stage/src/replay/playback-map.ts
// Replay time: session ms ↔ playback ms. Busy stretches play at real time; a quiet stretch of at
// least IDLE_MIN_MS is compressed to IDLE_KEEP_MS when idle is skipped (research §4.9: real
// timestamps with gap compression). Speed is applied separately, by the replay clock.

export const IDLE_MIN_MS = 1500;
export const IDLE_KEEP_MS = 400;

export interface Span {
  from: number;
  to: number;
}

export interface PlaybackSegment {
  s0: number;
  s1: number;
  p0: number;
  p1: number;
  idle: boolean;
}

export interface PlaybackMap {
  startMs: number;
  endMs: number;
  skipIdle: boolean;
  segments: PlaybackSegment[];
}

// Sorted, clipped to [lo, hi], overlapping or touching spans merged; empty spans dropped.
export function mergeSpans(spans: Span[], lo: number, hi: number): Span[] {
  const clipped = spans
    .map((s) => ({ from: Math.max(lo, s.from), to: Math.min(hi, s.to) }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);
  const out: Span[] = [];
  for (const s of clipped) {
    const last = out.at(-1);
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

export function buildPlaybackMap(
  startMs: number,
  endMs: number,
  busy: Span[],
  skipIdle: boolean,
): PlaybackMap {
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs)) || endMs < startMs) {
    throw new RangeError("a playback map needs finite start ≤ end");
  }
  const segments: PlaybackSegment[] = [];
  let p = 0;
  const push = (s0: number, s1: number, idle: boolean) => {
    if (s1 <= s0) return;
    const len = idle && skipIdle ? IDLE_KEEP_MS : s1 - s0;
    segments.push({ s0, s1, p0: p, p1: p + len, idle: idle && skipIdle });
    p += len;
  };
  let at = startMs;
  for (const b of mergeSpans(busy, startMs, endMs)) {
    push(at, b.from, b.from - at >= IDLE_MIN_MS);
    push(b.from, b.to, false);
    at = b.to;
  }
  push(at, endMs, endMs - at >= IDLE_MIN_MS);
  return { startMs, endMs, skipIdle, segments };
}

export function playDuration(map: PlaybackMap): number {
  return map.segments.at(-1)?.p1 ?? 0;
}

// Last segment whose start is ≤ v under `key`; segments are contiguous in both clocks.
function find(map: PlaybackMap, v: number, k0: "p0" | "s0"): PlaybackSegment | undefined {
  const segs = map.segments;
  let lo = 0;
  let hi = segs.length - 1;
  let best: PlaybackSegment | undefined = segs[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid] as PlaybackSegment;
    if (s[k0] <= v) {
      best = s;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export function sessionAt(map: PlaybackMap, playMs: number): number {
  const seg = find(map, playMs, "p0");
  if (!seg) return map.startMs;
  const u = Math.min(1, Math.max(0, (playMs - seg.p0) / (seg.p1 - seg.p0)));
  return seg.s0 + u * (seg.s1 - seg.s0);
}

export function playAt(map: PlaybackMap, sessionMs: number): number {
  const seg = find(map, sessionMs, "s0");
  if (!seg) return 0;
  const u = Math.min(1, Math.max(0, (sessionMs - seg.s0) / (seg.s1 - seg.s0)));
  return seg.p0 + u * (seg.p1 - seg.p0);
}

export function idleAt(map: PlaybackMap, sessionMs: number): boolean {
  const seg = find(map, sessionMs, "s0");
  return seg?.idle === true && sessionMs >= seg.s0 && sessionMs < seg.s1;
}
