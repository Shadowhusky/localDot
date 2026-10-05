import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { type FragmentEntry, RECORDING_VIDEO } from "@localdot/protocol";
import { mfraBox } from "./boxes.ts";
import { readFragments } from "./recover.ts";

export interface RecordingView {
  size: number;
  read(start: number, end: number): Uint8Array;
  close(): void;
}
export interface ViewOptions {
  complete: boolean;
  entries?: readonly FragmentEntry[];
  upto?: number;
}
export class NoFragmentsError extends Error {
  constructor() {
    super("recording has no committed fragments");
    this.name = "NoFragmentsError";
  }
}

export function openRecordingView(dir: string, opts: ViewOptions): RecordingView {
  const path = join(dir, RECORDING_VIDEO);
  let prefix: number;
  let tail: Uint8Array = new Uint8Array();
  if (opts.complete) {
    try {
      prefix = statSync(path).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NoFragmentsError();
      throw error;
    }
    if (!prefix) throw new NoFragmentsError();
  } else {
    const entries = opts.entries ?? readFragments(dir);
    const upto = opts.upto ?? entries.length;
    if (!Number.isSafeInteger(upto) || upto < 0 || upto > entries.length)
      throw new RangeError("invalid recording snapshot fragment count");
    if (upto === 0) throw new NoFragmentsError();
    const snapshot = entries.slice(0, upto);
    const last = snapshot.at(-1);
    if (!last) throw new NoFragmentsError();
    prefix = last.endOffset;
    tail = mfraBox([...snapshot]);
  }
  const size = prefix + tail.length;
  const fd = openSync(path, "r");
  let closed = false;
  return {
    size,
    read(start, end) {
      if (closed) throw new Error("recording view is closed");
      if (![start, end].every((n) => Number.isSafeInteger(n) && n >= 0) || end < start)
        throw new RangeError("invalid recording byte range");
      end = Math.min(end, size);
      if (start >= end) return new Uint8Array();
      const out = new Uint8Array(end - start);
      const fileEnd = Math.min(end, prefix);
      let written = 0;
      while (start + written < fileEnd) {
        const count = readSync(fd, out, written, fileEnd - start - written, start + written);
        if (count === 0) throw new Error("recording snapshot prefix was truncated");
        written += count;
      }
      if (end > prefix)
        out.set(
          tail.subarray(Math.max(0, start - prefix), end - prefix),
          Math.max(0, prefix - start),
        );
      return out;
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
  };
}
