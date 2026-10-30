import type { EventLog } from "../event-log.ts";
import type { FrameStore } from "../gateway/frames.ts";
import { type ComputerAccess, computerConverter } from "./convert.ts";
import { macOpener } from "./open-on-mac.ts";
import { Previews } from "./previews.ts";
import type { DeliverablesDeps, ReviseDeps } from "./routes.ts";
import { TaskScanner } from "./task-scan.ts";

export function deliverablesFor(
  home: string,
  eventLog: Pick<EventLog, "hasSession" | "logFile">,
  frames: Pick<FrameStore, "path">,
  d: {
    computers(): readonly { id: string; state: string; paused?: boolean }[];
    access(cellId: string, signal: AbortSignal): ComputerAccess | "busy" | undefined;
    cellOf(sessionId: string): string | undefined;
    start: ReviseDeps["start"];
    upload: ReviseDeps["access"];
    redactUserText: ReviseDeps["redactUserText"];
  },
): Omit<DeliverablesDeps, "port"> {
  return {
    home,
    eventLog,
    scanner: new TaskScanner(eventLog),
    frames,
    previews: new Previews(home, computerConverter({ computers: d.computers, access: d.access })),
    opener: macOpener(),
    revise: { start: d.start, access: d.upload, redactUserText: d.redactUserText },
    computer: { cellOf: d.cellOf, access: d.access },
  };
}
