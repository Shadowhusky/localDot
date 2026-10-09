import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { StopAllOutcome } from "@localdot/protocol";

export interface StopAllAudit {
  append(record: { at: number; by: "user" | "cli"; outcome: StopAllOutcome }): void;
}

/** Who stopped everything and what was confirmed, one JSON line each in
 * <home>/audit/stop-all.jsonl. Ids and booleans only, never task text or keys.
 */
export function fileStopAllAudit(home: string): StopAllAudit {
  const directory = join(home, "audit");
  return {
    append({ at, by, outcome }) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw new Error("audit folder is not private");
      const fd = openSync(
        join(directory, "stop-all.jsonl"),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(
          fd,
          `${JSON.stringify({ v: 1, at: new Date(at).toISOString(), by, ...outcome })}\n`,
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
  };
}
