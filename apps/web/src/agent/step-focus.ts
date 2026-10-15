// A step a chat row asks Activity to show, with its details open. The newest request wins; Activity
// takes it once the step is on its list, and a request nothing takes lapses.
export interface StepFocus {
  readonly key: string;
  readonly serial: number;
  readonly at: number;
}

const LAPSE_MS = 10_000;
let wanted: StepFocus | null = null;
let serial = 0;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export function showStep(key: string): void {
  wanted = { key, serial: ++serial, at: Date.now() };
  changed();
}

export function wantedStep(): StepFocus | null {
  return wanted && Date.now() - wanted.at < LAPSE_MS ? wanted : null;
}

export function takeStep(taken: number): void {
  if (wanted?.serial !== taken) return;
  wanted = null;
  changed();
}

export function onStepFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
