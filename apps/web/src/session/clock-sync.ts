import { microsToMs, msToMicros } from "@localdot/protocol";

export interface ViewerClockSample {
  offsetMicros: number;
  rttMicros: number;
}

export interface SessionClock {
  offsetMicros: number;
  originMicros: number;
}

// One ping of `GET /api/clock`: viewer wall ms when it left and when its reply arrived, and the
// daemon's microseconds in the reply.
export interface ClockPing {
  sent: number;
  got: number;
  nowMicros: number;
}

// Viewer wall clock (performance.timeOrigin + performance.now(), ms) → daemon microseconds:
// daemonMicros = msToMicros(wallMs) + offsetMicros, from the burst's lowest-RTT ping, as the
// daemon does for desktopd.
export function lowestRttSample(pings: ClockPing[]): ViewerClockSample {
  let best: ViewerClockSample | undefined;
  for (const { sent, got, nowMicros } of pings) {
    const candidate = {
      offsetMicros: nowMicros - msToMicros((sent + got) / 2),
      rttMicros: msToMicros(got - sent),
    };
    if (!best || candidate.rttMicros < best.rttMicros) best = candidate;
  }
  if (!best) throw new RangeError("a clock sync needs at least one ping");
  return best;
}

export async function syncClock(
  fetchImpl: typeof fetch,
  origin: string,
  token: string,
  samples = 12,
  now: () => number = () => performance.timeOrigin + performance.now(),
): Promise<ViewerClockSample> {
  const pings: ClockPing[] = [];
  for (let i = 0; i < samples; i++) {
    const sent = now();
    const res = await fetchImpl(`${origin}/api/clock`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`clock: ${res.status}`);
    const { nowMicros } = (await res.json()) as { nowMicros: number };
    pings.push({ sent, got: now(), nowMicros });
  }
  return lowestRttSample(pings);
}

// Session milliseconds (the renderer's unit) of a viewer wall-clock instant.
export function sessionMsAt(wallMs: number, clock: SessionClock): number {
  return microsToMs(msToMicros(wallMs) + clock.offsetMicros - clock.originMicros);
}
