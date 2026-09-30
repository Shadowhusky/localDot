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
