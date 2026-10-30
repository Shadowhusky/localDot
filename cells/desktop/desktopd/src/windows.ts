import { readFile } from "node:fs/promises";
import type { ScreenWindow, WindowsRequest, WindowsResult } from "@localdot/protocol";
import { windowStack } from "./perception/hit-test.ts";
import type { XHelper } from "./x/helper.ts";

// Linux reports process start and uptime in these clock ticks.
const TICKS_PER_SECOND = 100;

const SHELLS_KEPT = 256;

// The shell commands' process sessions: a program a command starts in the background keeps its
// command's session, and so do its windows.
export class ShellSessions {
  readonly #commands = new Map<number, string>();
  add(sid: number, command: string): void {
    this.#commands.delete(sid);
    this.#commands.set(sid, command);
    if (this.#commands.size > SHELLS_KEPT)
      this.#commands.delete(this.#commands.keys().next().value as number);
  }
  of(sid: number | undefined): string | undefined {
    return sid === undefined ? undefined : this.#commands.get(sid);
  }
}

export interface WindowsDeps {
  x: XHelper;
  shells?: ShellSessions;
  read?(path: string): Promise<string>;
}

const readText = (path: string) => readFile(path, "utf8");

// A process's session and start, from /proc/<pid>/stat (fields 6 and 22, after the name).
async function processOf(
  read: (path: string) => Promise<string>,
  pid: number,
): Promise<Pick<ScreenWindow, "sid" | "started">> {
  if (pid <= 0) return {};
  try {
    const stat = await read(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const sid = Number(fields[3]);
    const started = Number(fields[19]);
    return {
      ...(Number.isSafeInteger(sid) && sid > 0 ? { sid } : {}),
      ...(Number.isSafeInteger(started) && started >= 0 ? { started } : {}),
    };
  } catch {
    return {};
  }
}

// The windows top first, each with the program that shows it, and the clock to compare its start
// with; a window asked for is brought forward first.
export async function screenWindows(
  deps: WindowsDeps,
  request: WindowsRequest,
): Promise<WindowsResult> {
  const read = deps.read ?? readText;
  if (request.activate) await deps.x.call("activate", { window: request.activate });
  const [uptime, stack] = await Promise.all([read("/proc/uptime"), windowStack(deps.x)]);
  const ticks = Math.floor(Number(uptime.split(" ")[0]) * TICKS_PER_SECOND);
  const windows = await Promise.all(
    stack.windows.map(async (w) => {
      const process = await processOf(read, w.pid);
      const command = deps.shells?.of(process.sid);
      return {
        id: w.id,
        pid: w.pid,
        ...process,
        ...(command ? { command } : {}),
        frame: { x: w.frame[0], y: w.frame[1], w: w.frame[2], h: w.frame[3] },
        active: w.active,
        transientFor: w.transientFor,
      };
    }),
  );
  return { ticks: Number.isSafeInteger(ticks) ? ticks : 0, windows };
}
