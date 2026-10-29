import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

// At most `max` bytes of a regular file, never through a link: its start, or its end.
function readFile(
  file: string,
  max: number,
  from: "start" | "end",
): { text: string; whole: boolean } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const length = Math.min(stat.size, max);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, from === "end" ? stat.size - length : 0);
    return { text: buffer.subarray(0, read).toString("utf8"), whole: length === stat.size };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const readHead = (file: string, max = 64 * 1024) => readFile(file, max, "start")?.text;

// Whole lines from a file's end; the first is dropped when the window began inside it.
export function tailLines(
  file: string,
  max: number,
): { lines: string[]; whole: boolean } | undefined {
  const tail = readFile(file, max, "end");
  if (!tail) return undefined;
  const lines = tail.text.split("\n");
  if (!tail.whole) lines.shift();
  return { lines: lines.filter((line) => line.trim()), whole: tail.whole };
}
