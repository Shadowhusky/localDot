// The log uses microseconds, the renderer and desktop helper use milliseconds.
export const MICROS_PER_MS = 1000;

export function requireFinite(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be finite, got ${value}`);
  return value;
}
export function microsToMs(micros: number): number {
  return requireFinite(micros, "microseconds") / MICROS_PER_MS;
}
export function msToMicros(ms: number): number {
  return Math.round(requireFinite(ms, "milliseconds") * MICROS_PER_MS);
}
export function msToSeconds(ms: number): number {
  return requireFinite(ms, "milliseconds") / 1000;
}
export function sessionMsOf(event: { t: number }): number {
  return microsToMs(event.t);
}
