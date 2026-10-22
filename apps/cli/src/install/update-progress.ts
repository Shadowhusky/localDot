import { writeSync } from "node:fs";
import type { UpdateProgressLine } from "../../../../packages/protocol/src/app-update.ts";

const EVERY_MS = 250;

/** The progress channel the app opens for a preparing updater: descriptor 3, written only when
 * LOCALDOT_PROGRESS_FD says so, since a shell may hold another file there. Lines of one step go
 * out at most every 250 ms; a closed channel ends the reporting, never the work. */
export function updateProgressReporter(
  env: NodeJS.ProcessEnv = process.env,
  write: (fd: number, text: string) => unknown = writeSync,
): ((line: UpdateProgressLine) => void) | undefined {
  if (env.LOCALDOT_PROGRESS_FD !== "3") return;
  let open = true,
    step = "",
    at = 0;
  return (line) => {
    const now = Date.now();
    if (!open || (line.step === step && now - at < EVERY_MS)) return;
    step = line.step;
    at = now;
    try {
      write(3, `${JSON.stringify(line)}\n`);
    } catch (error) {
      // A full pipe drops this line; any other error means nobody is listening.
      if (!(error && typeof error === "object" && "code" in error && error.code === "EAGAIN"))
        open = false;
    }
  };
}
