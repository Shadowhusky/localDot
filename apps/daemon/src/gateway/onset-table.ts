import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Injector, Input } from "@localdot/protocol";
import { z } from "zod";

export type OnsetKind = "click" | "key";
type ScaleKey = "1" | "2";
type Scales = Record<ScaleKey, number>;

// The driver fallback has no key row (P3-C9): typed text through it is timed from the raw press
// like a click, and key combos never travel that path.
export interface OnsetTable {
  v: 1;
  source: "defaults" | "calibration";
  measuredAt?: string;
  onsetMs: { xtest: Record<OnsetKind, Scales>; driver: { click: Scales } };
}

// S6 on the development Mac (M3 Ultra), 50–120 trials per group, so each p99 is a sample maximum
// (D8). The calibration tool (Task 6) replaces them with ≥ 500-trial p99s per machine.
export const DEFAULT_ONSET_TABLE: OnsetTable = {
  v: 1,
  source: "defaults",
  onsetMs: {
    xtest: { click: { "1": 19.6, "2": 23.1 }, key: { "1": 19.1, "2": 29.3 } },
    driver: { click: { "1": 18.4, "2": 26.4 } },
  },
};

const GROUPS: readonly [Injector, OnsetKind][] = [
  ["xtest", "click"],
  ["xtest", "key"],
  ["driver", "click"],
];

const Group = z.object({
  "1": z.number().positive().optional(),
  "2": z.number().positive().optional(),
});
export const CalibrationFile = z.object({
  v: z.literal(1),
  measuredAt: z.string(),
  machine: z.string().optional(),
  trials: z.number().int().optional(),
  onsetMs: z.object({
    xtest: z.object({ click: Group.optional(), key: Group.optional() }).optional(),
    driver: z.object({ click: Group.optional() }).optional(),
  }),
});
export type CalibrationFile = z.infer<typeof CalibrationFile>;

function row(
  table: OnsetTable["onsetMs"],
  injector: Injector,
  kind: OnsetKind,
): Scales | undefined {
  return injector === "xtest"
    ? table.xtest[kind]
    : kind === "click"
      ? table.driver.click
      : undefined;
}

export function loadOnsetTable(home: string): OnsetTable {
  const file = join(home, "calibration.json");
  let parsed: CalibrationFile;
  try {
    parsed = CalibrationFile.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(`ignoring ${file}: ${String(err)}`);
    else
      console.error(
        `no ${file}: using the development Mac's ring onsets; run pnpm --filter @localdot/web calibrate --compositor on`,
      );
    return DEFAULT_ONSET_TABLE;
  }
  const onsetMs = structuredClone(DEFAULT_ONSET_TABLE.onsetMs);
  for (const [injector, kind] of GROUPS) {
    const measured =
      injector === "xtest" ? parsed.onsetMs.xtest?.[kind] : parsed.onsetMs.driver?.click;
    const target = row(onsetMs, injector, kind) as Scales;
    for (const scale of ["1", "2"] as const) {
      const v = measured?.[scale];
      if (v !== undefined) target[scale] = v;
    }
  }
  return { v: 1, source: "calibration", measuredAt: parsed.measuredAt, onsetMs };
}

export function onsetKind(input: Input): OnsetKind {
  return input.kind === "type" || input.kind === "key" ? "key" : "click";
}

export function onsetMs(
  table: OnsetTable,
  injector: Injector,
  kind: OnsetKind,
  scale: 1 | 2,
): number {
  // Driver-typed text is timed from its first raw press with the click row (the same XTest-like
  // delivery); driver key combos do not exist (P3-C9).
  const r = row(table.onsetMs, injector, injector === "driver" ? "click" : kind);
  if (!r) throw new Error(`no ring onset row for ${injector} ${kind}`);
  return r[String(scale) as ScaleKey];
}
