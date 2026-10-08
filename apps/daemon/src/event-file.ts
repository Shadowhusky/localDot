import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type LocalDotEvent, parseEvent, ULID_PATTERN } from "@localdot/protocol";

// Only the unterminated tail can be a torn write; a complete line that fails to parse is skipped.
export function readValid(file: string): { events: LocalDotEvent[]; validBytes: number } {
  if (!existsSync(file)) return { events: [], validBytes: 0 };
  const bytes = readFileSync(file);
  const validBytes = bytes.lastIndexOf(0x0a) + 1;
  const events = bytes
    .subarray(0, validBytes)
    .toString("utf8")
    .split("\n")
    .flatMap((line) => parseLine(line) ?? []);
  return { events, validBytes };
}

export function parseLine(line: string): LocalDotEvent | undefined {
  try {
    return parseEvent(JSON.parse(line));
  } catch {
    return undefined;
  }
}

// Reads the log file alone, never the index, so a stopped service can ask too. A log that cannot be
// read has not recorded an end.
export function sessionEnded(home: string, sessionId: string): boolean {
  try {
    return (
      ULID_PATTERN.test(sessionId) &&
      readValid(join(home, "sessions", sessionId, "events.jsonl")).events.some(
        (event) => event.type === "session.end",
      )
    );
  } catch {
    return false;
  }
}
