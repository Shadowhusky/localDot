import { type Injector, msToMicros } from "@localdot/protocol";
import { type OnsetKind, type OnsetTable, onsetMs } from "./onset-table.ts";

export interface RingOnsetInput {
  pressT: number;
  injector: Injector;
  kind: OnsetKind;
  scale: 1 | 2;
  // Session microseconds of the first screen change at the dispatch point, when the policy wants it.
  changeAt?: () => Promise<number | undefined>;
}

// Success criterion 3 (A1) is pending the user's sign-off between these two; the gateway only ever
// sees this interface, so switching is a one-line change in main.ts.
export interface RingOnsetPolicy {
  readonly name: "keep" | "strict";
  onset(input: RingOnsetInput): Promise<number>;
}

const latest = (table: OnsetTable, i: RingOnsetInput) =>
  i.pressT + msToMicros(onsetMs(table, i.injector, i.kind, i.scale));

// keep: the ring means "input delivered" and starts at the raw press plus that injector's p99 (A8).
export function keepPolicy(table: OnsetTable): RingOnsetPolicy {
  return { name: "keep", onset: async (i) => latest(table, i) };
}

// strict: the ring starts on the first frame that changes at the dispatch point, with the p99 as
// the timeout; it needs desktopd's change-at-point report (see "What changes for strict" below).
export function strictPolicy(table: OnsetTable): RingOnsetPolicy {
  return {
    name: "strict",
    onset: async (i) => {
      const cap = latest(table, i);
      const change = i.changeAt ? await i.changeAt() : undefined;
      return change === undefined ? cap : Math.max(i.pressT, Math.min(change, cap));
    },
  };
}

export function policyFromEnv(
  table: OnsetTable,
  env: NodeJS.ProcessEnv = process.env,
): RingOnsetPolicy {
  const name = env.LOCALDOT_RING_ONSET ?? "keep";
  if (name === "keep") return keepPolicy(table);
  if (name === "strict") return strictPolicy(table);
  throw new RangeError(`LOCALDOT_RING_ONSET must be keep or strict, got ${name}`);
}
