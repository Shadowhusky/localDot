import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function localdotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCALDOT_HOME || join(homedir(), ".localdot");
}

// The safety stores refuse a home that others can read. A home made by an earlier tool with the
// usual 0755 used to disable them silently, so the daemon makes its home private instead.
export function secureHome(home: string): { tightened: boolean } {
  if (!lstatSync(home, { throwIfNoEntry: false }))
    mkdirSync(home, { recursive: true, mode: 0o700 });
  const st = lstatSync(home);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) {
    throw new Error(`${home} is not a directory you own; point LOCALDOT_HOME elsewhere`);
  }
  if ((st.mode & 0o077) === 0) return { tightened: false };
  chmodSync(home, st.mode & 0o700);
  return { tightened: true };
}
