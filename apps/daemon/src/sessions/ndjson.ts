import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseEvent } from "@localdot/protocol";
export const NDJSON_TYPE = "application/x-ndjson";
// The model's thinking and the heartbeats make up most of a long log, and the conversation shows
// neither.
const UNSHOWN = new Set(["thought.delta", "heartbeat"]);
export function streamEventLines(
  file: string,
  fromSeq = 0,
  { shown = false }: { shown?: boolean } = {},
): AsyncGenerator<string> {
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
  return readSnapshot(file, fromSeq, size, complete, shown);
}

async function* readSnapshot(
  file: string,
  fromSeq: number,
  size: number,
  complete: boolean,
  shown: boolean,
): AsyncGenerator<string> {
  if (size === 0) return;
  // Unshown events are left out before they are checked, which is most of the work on a long log.
  const line = (text: string): string | undefined => {
    const raw = JSON.parse(text);
    if (shown && UNSHOWN.has(raw?.type)) return undefined;
    const event = parseEvent(raw);
    return event.seq >= fromSeq ? `${JSON.stringify(event)}\n` : undefined;
  };
  const stream = createReadStream(file, { start: 0, end: size - 1, highWaterMark: 64 * 1024 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let previous: string | undefined;
    for await (const text of lines) {
      if (previous !== undefined) {
        let out: string | undefined;
        try {
          out = line(previous);
        } catch {
          /* invalid complete lines are omitted */
        }
        if (out) yield out;
      }
      previous = text;
    }
    if (complete && previous !== undefined) {
      let out: string | undefined;
      try {
        out = line(previous);
      } catch {
        /* invalid complete lines are omitted */
      }
      if (out) yield out;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
