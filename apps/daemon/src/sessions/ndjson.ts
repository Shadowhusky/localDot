import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseEvent } from "@localdot/protocol";
export const NDJSON_TYPE = "application/x-ndjson";
export function streamEventLines(file: string, fromSeq = 0): AsyncGenerator<string> {
  const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  let complete = false;
  if (size > 0) {
    const descriptor = openSync(file, "r");
    try {
      const byte = Buffer.alloc(1);
      complete = readSync(descriptor, byte, 0, 1, size - 1) === 1 && byte[0] === 10;
    } finally {
      closeSync(descriptor);
    }
  }
  return readSnapshot(file, fromSeq, size, complete);
}

async function* readSnapshot(
  file: string,
  fromSeq: number,
  size: number,
  complete: boolean,
): AsyncGenerator<string> {
  if (size === 0) return;
  const stream = createReadStream(file, { start: 0, end: size - 1, highWaterMark: 64 * 1024 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let previous: string | undefined;
    for await (const line of lines) {
      if (previous !== undefined) {
        try {
          const event = parseEvent(JSON.parse(previous));
          if (event.seq >= fromSeq) yield `${JSON.stringify(event)}\n`;
        } catch {
          /* invalid complete lines are omitted */
        }
      }
      previous = line;
    }
    if (complete && previous !== undefined) {
      try {
        const event = parseEvent(JSON.parse(previous));
        if (event.seq >= fromSeq) yield `${JSON.stringify(event)}\n`;
      } catch {
        /* invalid complete lines are omitted */
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
