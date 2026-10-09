import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  type LocalDotEvent,
  RECENT_TASKS,
  type RecentOutcome,
  type RecentTask,
} from "@localdot/protocol";
import { parseLine } from "../event-file.ts";
import type { EventLog } from "../event-log.ts";
import { localDay } from "./memory-entries.ts";

const EDGE_BYTES = 16 * 1024;
const LOOK_BACK = 30;

// The events in the first or last bytes of a log: a task's request opens it and its end closes it.
function edge(file: string, end: boolean): LocalDotEvent[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const size = fstatSync(fd).size;
    const length = Math.min(size, EDGE_BYTES);
    const bytes = Buffer.alloc(length);
    const read = readSync(fd, bytes, 0, length, end ? size - length : 0);
    const lines = bytes.subarray(0, read).toString("utf8").split("\n");
    // A cut line at either end of the window is not an event.
    return (end ? lines.slice(1) : lines.slice(0, -1)).flatMap((line) => parseLine(line) ?? []);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The user's last few tasks as they typed them, how each ended and its day: never what dot read
// or wrote during them.
export class RecentActivity {
  constructor(
    private readonly deps: {
      log: Pick<EventLog, "listSessions" | "logFile">;
      isLive(sessionId: string): boolean;
    },
  ) {}
  list(exclude?: string, limit = RECENT_TASKS): RecentTask[] {
    const tasks: RecentTask[] = [];
    for (const session of this.deps.log.listSessions().slice(0, LOOK_BACK)) {
      if (tasks.length >= limit) break;
      const title = session.title?.replace(/\s+/g, " ").trim();
      if (session.id === exclude || !title) continue;
      let file: string;
      try {
        file = this.deps.log.logFile(session.id);
      } catch {
        continue;
      }
      if (!edge(file, false).some((event) => event.type === "message.user")) continue;
      tasks.push({
        sessionId: session.id,
        title,
        outcome: this.#outcome(session.id, file),
        day: localDay(new Date(session.startedAt)),
      });
    }
    return tasks;
  }
  #outcome(sessionId: string, file: string): RecentOutcome {
    if (this.deps.isLive(sessionId)) return "running";
    const ended = edge(file, true).findLast((event) => event.type === "session.end");
    return ended?.type === "session.end" ? ended.data.reason : "interrupted";
  }
}
