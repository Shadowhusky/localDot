import type { SpringParams } from "@localdot/stage";

// The velocity (units/s) of the spring springValue describes, so a retarget can carry it over.
export function springVelocity(
  from: number,
  to: number,
  velocity: number,
  tSeconds: number,
  p: SpringParams,
): number {
  const omega = (2 * Math.PI) / p.response;
  const zeta = p.dampingRatio;
  const x0 = from - to;
  const t = tSeconds;
  if (zeta < 1) {
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    const b = (velocity + zeta * omega * x0) / omegaD;
    const c = Math.cos(omegaD * t);
    const s = Math.sin(omegaD * t);
    return (
      Math.exp(-zeta * omega * t) * (-zeta * omega * (x0 * c + b * s) + omegaD * (b * c - x0 * s))
    );
  }
  if (zeta === 1) {
    const b = velocity + omega * x0;
    return Math.exp(-omega * t) * (b - omega * (x0 + b * t));
  }
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega * (zeta - root);
  const r2 = -omega * (zeta + root);
  const a = (velocity - r2 * x0) / (r1 - r2);
  return a * r1 * Math.exp(r1 * t) + (x0 - a) * r2 * Math.exp(r2 * t);
}
