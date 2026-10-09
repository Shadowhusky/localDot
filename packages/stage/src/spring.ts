// Apple-style parameters: dampingRatio (1 = critically damped) and response (seconds per cycle).
export interface SpringParams {
  dampingRatio: number;
  response: number;
}

export const SPRING_DEFAULT: SpringParams = { dampingRatio: 1, response: 0.4 };

export function springValue(
  from: number,
  to: number,
  velocity: number,
  tSeconds: number,
  p: SpringParams,
): number {
  if (![from, to, velocity, tSeconds, p.response, p.dampingRatio].every(Number.isFinite)) {
    throw new RangeError("spring inputs must be finite");
  }
  if (p.response <= 0 || p.dampingRatio < 0) {
    throw new RangeError("spring needs response > 0 and dampingRatio >= 0");
  }
  const omega = (2 * Math.PI) / p.response;
  const zeta = p.dampingRatio;
  const x0 = from - to;
  const v0 = velocity;
  const t = tSeconds;

  if (zeta < 1) {
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega * t);
    return (
      to +
      decay *
        (x0 * Math.cos(omegaD * t) + ((v0 + zeta * omega * x0) / omegaD) * Math.sin(omegaD * t))
    );
  }
  if (zeta === 1) {
    return to + Math.exp(-omega * t) * (x0 + (v0 + omega * x0) * t);
  }
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega * (zeta - root);
  const r2 = -omega * (zeta + root);
  const a = (v0 - r2 * x0) / (r1 - r2);
  const b = x0 - a;
  return to + a * Math.exp(r1 * t) + b * Math.exp(r2 * t);
}

// A spring whose target changes at each step (session ms, in order), carrying its value and
// velocity across each change so a reversal never jumps; `kick` adds velocity at the step. Pure in
// t, so a replay draws the same frame. Settled within 2 responses, it sits exactly on its target.
export interface SpringStep {
  at: number;
  to: number;
  spring: SpringParams;
  kick?: number;
}

const DERIVATIVE_S = 1e-4;

export function springTrack(initial: number, steps: SpringStep[], tMs: number): number {
  let x = initial;
  let v = 0;
  let from = Number.NEGATIVE_INFINITY;
  let current: SpringStep | undefined;
  const advance = (until: number) => {
    if (!current) return;
    const s = (until - from) / 1000;
    if (s >= 2 * current.spring.response) {
      x = current.to;
      v = 0;
      return;
    }
    const next = springValue(x, current.to, v, s, current.spring);
    v = (springValue(x, current.to, v, s + DERIVATIVE_S, current.spring) - next) / DERIVATIVE_S;
    x = next;
  };
  for (const step of steps) {
    if (step.at > tMs) break;
    advance(step.at);
    from = step.at;
    current = step;
    v += step.kick ?? 0;
  }
  advance(tMs);
  return x;
}

// The share of a critically damped move done after `ms` with the given response.
export function springProgress(ms: number, response: number): number {
  if (ms <= 0) return 0;
  if (ms >= 2000 * response) return 1;
  return 1 - springValue(1, 0, 0, ms / 1000, { dampingRatio: 1, response });
}
