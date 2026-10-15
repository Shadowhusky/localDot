export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  out: (t: number) => 1 - (1 - t) ** 3,
  in: (t: number) => t * t * t,
} satisfies Record<string, Ease>;

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Where p is within [from, to], from 0 to 1.
export function span(p: number, from: number, to: number): number {
  return clamp01((p - from) / (to - from));
}

export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// A value keyed along progress: held before the first key and after the last, eased between.
export function track(
  keys: readonly (readonly [at: number, value: number])[],
  easing: Ease = ease.inOut,
): (p: number) => number {
  const first = keys[0];
  const last = keys.at(-1);
  if (!first || !last) throw new RangeError("A track needs at least one key.");
  return (p) => {
    if (p <= first[0]) return first[1];
    if (p >= last[0]) return last[1];
    let i = 1;
    while (i < keys.length - 1 && (keys[i] as readonly [number, number])[0] < p) i++;
    const [a, va] = keys[i - 1] as readonly [number, number];
    const [b, vb] = keys[i] as readonly [number, number];
    return mix(va, vb, easing((p - a) / (b - a)));
  };
}

// A damped follower: the gap to the target halves every halfLifeMs, whatever the frame rate.
export function follow(current: number, target: number, dtMs: number, halfLifeMs: number): number {
  if (dtMs <= 0) return current;
  return target + (current - target) * 2 ** (-dtMs / halfLifeMs);
}
