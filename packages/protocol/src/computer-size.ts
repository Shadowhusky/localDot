import { z } from "zod";

const GIB = 1024 ** 3;

// How much of Docker a dot's computer may take: its desktop's memory and CPUs. The web browser
// beside the desktop follows at today's ratio (browserShare).
export const ComputerSize = z.strictObject({
  memoryBytes: z.number().int().positive(),
  cpus: z.number().int().positive(),
});
export type ComputerSize = z.infer<typeof ComputerSize>;

export const DEFAULT_COMPUTER_SIZE: ComputerSize = { memoryBytes: 4 * GIB, cpus: 4 };
// The desktop settles near 1 GB and its stream takes about 2 CPUs while the screen moves at 2×
// (docs/measurements/2026-10-stream-2x.md), so less would leave nothing for the work itself.
export const MIN_COMPUTER_SIZE: ComputerSize = { memoryBytes: 2 * GIB, cpus: 2 };
export const MEMORY_STEP_BYTES = GIB / 2;

// Today's web browser has 3 GB to the desktop's 4 and 2 CPUs to its 4. It settles near 0.8 GB
// with a few tabs open, so it never gets less than 1.5 GB and one CPU.
const BROWSER_MIN = { memoryBytes: 1.5 * GIB, cpus: 1 };

export function browserShare(size: ComputerSize): { memoryBytes: number; cpus: number } {
  return {
    memoryBytes: Math.max(BROWSER_MIN.memoryBytes, (size.memoryBytes * 3) / 4),
    cpus: Math.max(BROWSER_MIN.cpus, size.cpus / 2),
  };
}

const Amount = z.strictObject({
  memoryBytes: z.number().nonnegative(),
  cpus: z.number().nonnegative(),
});

export const ComputerSizeView = z.strictObject({
  size: ComputerSize,
  default: ComputerSize,
  min: ComputerSize,
  // The most this dot can choose now: Docker's, less its headroom and what other running dots
  // hold. Below min when Docker can't hold even the smallest computer.
  max: Amount,
  docker: Amount.extend({
    // Where Docker's limits are raised: Docker Desktop's or OrbStack's settings, a VM of some
    // other app, or nowhere when Docker runs on this computer itself and has all of it.
    app: z.enum(["docker-desktop", "orbstack", "vm", "host"]),
  }),
  others: Amount,
  headroomBytes: z.number().int().nonnegative(),
  // The desktop's working set and CPUs while it runs; CPUs once a second look has measured them.
  usage: z
    .strictObject({ memoryBytes: z.number().nonnegative(), cpus: z.number().optional() })
    .nullable(),
  // Less memory than the computer uses now waits until it next starts.
  pending: z.boolean(),
});
export type ComputerSizeView = z.infer<typeof ComputerSizeView>;
