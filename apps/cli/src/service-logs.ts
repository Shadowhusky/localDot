import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { displayLogLine } from "../../daemon/src/daemon-log.ts";
import type { ConsoleIO } from "./runtime.ts";

const FILES = ["daemon.log", "keyd.log"] as const;
const WINDOW = 64 * 1024;
const LINES = 100;

function readRange(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(to - from);
    const read = readSync(fd, buffer, 0, buffer.length, from);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

// The service logs of an installation run by launchd or systemd, in <home>/logs. Only whole
// lines are shown, each made safe for the terminal; following picks up appended lines.
export async function printServiceLogs(
  context: { home: string; signal: AbortSignal; follow: boolean },
  io: ConsoleIO,
): Promise<number> {
  const offsets = new Map<string, number>();
  let shown = false;
  for (;;) {
    for (const name of FILES) {
      const file = join(context.home, "logs", name);
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      const last = offsets.get(name);
      // A log that shrank was rotated: start again from its end.
      const from = last === undefined || last > size ? Math.max(0, size - WINDOW) : last;
      const bytes = size > from ? readRange(file, from, size) : Buffer.alloc(0);
      const end = bytes.lastIndexOf(0x0a) + 1;
      offsets.set(name, from + end);
      let lines = bytes.subarray(0, end).toString("utf8").split("\n").slice(0, -1);
      if (last === undefined) lines = lines.slice(from > 0 ? 1 : 0).slice(-LINES);
      for (const line of lines) io.out(`[${name}] ${displayLogLine(line)}`);
      shown ||= lines.length > 0;
    }
    if (!context.follow) break;
    await delay(500, undefined, { signal: context.signal });
  }
  if (!shown) io.out(`No service log entries yet in ${join(context.home, "logs")}.`);
  return 0;
}
