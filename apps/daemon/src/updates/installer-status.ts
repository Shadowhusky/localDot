import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { UpdateInstallStatus } from "../../../../packages/protocol/src/app-update.ts";
import type { InstallerState } from "./app-updater.ts";

const MAX_BYTES = 1024;
const TERMINAL = new Set(["done", "failed"]);

export const installerStatusFile = (home: string) => join(home, "app-update-install.json");

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A killed installer's swap is undone by the watcher it left, whose pid is on the journal's 2nd line.
function watcherAlive(journal: string | undefined) {
  if (!journal) return false;
  try {
    const pid = Number(readFileSync(journal, "utf8").split("\n")[1]);
    return Number.isInteger(pid) && pid > 0 && alive(pid);
  } catch {
    return false;
  }
}

/** The status file an installer keeps. It runs detached, in its own process group. */
export function installerStatus(home: string, swapJournal?: string) {
  const file = installerStatusFile(home);
  let pid: number | undefined;
  return {
    async read(): Promise<InstallerState | null> {
      try {
        const text = await readFile(file, "utf8");
        if (text.length > MAX_BYTES) return null;
        const status = UpdateInstallStatus.parse(JSON.parse(text));
        pid = status.pid;
        return {
          stage: status.stage,
          problem: status.problem,
          restored: status.restored,
          running: !TERMINAL.has(status.stage) && (alive(status.pid) || watcherAlive(swapJournal)),
        };
      } catch {
        return null;
      }
    },
    async reset() {
      pid = undefined;
      await rm(file, { force: true });
    },
    // Only ever before the swap: its own exit trap then finds nothing to put back.
    cancel() {
      if (!pid) return;
      const group = pid;
      try {
        process.kill(-group, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(-group, "SIGKILL");
          } catch {}
        }, 15_000).unref();
      } catch {}
    },
  };
}
