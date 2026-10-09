import { statSync } from "node:fs";
import type { LocalDotEvent, ReviseLink } from "@localdot/protocol";
import type { EventLog } from "../event-log.ts";
import { streamEventLines } from "../sessions/ndjson.ts";

export interface ScannedFile {
  name: string;
  bytes: number;
  version: number | null;
}
export interface ScannedFrame {
  frameId: string;
  tMs: number;
  step: string | null;
  seq: number;
}
// What happened between the previous result (or the start) and this one.
interface Turn {
  startMs: number;
  frames: ScannedFrame[];
  changes: Map<string, { size: number; seq: number }>;
  settles: Map<string, number>;
  checked: string | null;
}
export interface ScannedResult extends Turn {
  id: string;
  seq: number;
  tMs: number;
  files: ScannedFile[];
}
export interface TaskScan {
  title: string | null;
  revises: ReviseLink | null;
  results: ScannedResult[];
}

const ms = (t: number) => Math.round(t / 1000);
// The only events a scan uses; every other log line is skipped before it is parsed again.
const SCANNED =
  /"type":"(?:session\.start|observe|file\.change|screen\.settle|step\.verify|task\.result)"/;

export function scanEvents(events: Iterable<LocalDotEvent>): TaskScan {
  const scanner = taskScan();
  for (const e of events) scanner.push(e);
  return scanner.scan;
}
function taskScan(): { scan: TaskScan; push(e: LocalDotEvent): void } {
  const scan: TaskScan = { title: null, revises: null, results: [] };
  let open = fresh(0);
  const push = (e: LocalDotEvent) => {
    switch (e.type) {
      case "session.start":
        scan.title = e.data.title ?? scan.title;
        scan.revises = e.data.revises ?? scan.revises;
        break;
      case "observe":
        open.frames.push({
          frameId: e.data.frameId,
          tMs: ms(e.t),
          step: e.step ?? null,
          seq: e.seq,
        });
        break;
      case "file.change":
        if (e.step) {
          const prior = open.changes.get(e.step);
          open.changes.set(e.step, {
            size: (prior?.size ?? 0) + Math.max(1, e.data.patch?.length ?? 0),
            seq: prior?.seq ?? e.seq,
          });
        }
        break;
      case "screen.settle":
        if (e.step && !e.data.noVisibleChange)
          open.settles.set(
            e.step,
            (open.settles.get(e.step) ?? 0) + e.data.changed.reduce((a, r) => a + r.w * r.h, 0),
          );
        break;
      case "step.verify":
        open.checked = e.data.status === "success" && e.data.evidence ? e.data.evidence : null;
        break;
      case "task.result":
        scan.results.push({
          ...open,
          id: e.id,
          seq: e.seq,
          tMs: ms(e.t),
          files: e.data.files.map((f) => ({
            name: f.name,
            bytes: f.bytes,
            version: f.version ?? null,
          })),
        });
        open = fresh(ms(e.t));
        break;
    }
  };
  return { scan, push };
}
function fresh(startMs: number): Turn {
  return { startMs, frames: [], changes: new Map(), settles: new Map(), checked: null };
}

// One streaming pass over a task's log, cached until the log grows.
export class TaskScanner {
  readonly #cache = new Map<string, { size: number; scan: TaskScan }>();
  readonly #reading = new Map<string, Promise<TaskScan>>();
  constructor(private readonly eventLog: Pick<EventLog, "hasSession" | "logFile">) {}
  async scan(id: string): Promise<TaskScan | undefined> {
    if (!this.eventLog.hasSession(id)) return undefined;
    const file = this.eventLog.logFile(id);
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    const hit = this.#cache.get(id);
    if (hit && hit.size === size) return hit.scan;
    // Every file card of a result asks at once: concurrent requests share one read.
    const key = `${id}:${size}`;
    let reading = this.#reading.get(key);
    if (!reading) {
      reading = read(file).finally(() => this.#reading.delete(key));
      this.#reading.set(key, reading);
    }
    const scan = await reading;
    this.#cache.delete(id);
    this.#cache.set(id, { size, scan });
    if (this.#cache.size > 32) this.#cache.delete(this.#cache.keys().next().value as string);
    return scan;
  }
}
async function read(file: string): Promise<TaskScan> {
  const scanner = taskScan();
  for await (const line of streamEventLines(file))
    if (SCANNED.test(line)) scanner.push(JSON.parse(line) as LocalDotEvent);
  return scanner.scan;
}
