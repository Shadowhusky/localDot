export interface Clock {
  nowMicros(): number;
}

export function monotonicClock(): Clock {
  const origin = process.hrtime.bigint();
  return { nowMicros: () => Number((process.hrtime.bigint() - origin) / 1000n) };
}
