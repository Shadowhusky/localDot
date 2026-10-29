import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ULID_PATTERN } from "../../../../packages/protocol/src/ids.ts";
import type { DockerClient } from "../cells/docker.ts";
import { NAME_PREFIX } from "../cells/spec.ts";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";

// A computer copied from another dot waits here, as a system-state snapshot, until this dot makes
// its first computer from it.
export const COMPUTER_IMPORT_FILE = "computer-import.json";
const ComputerImport = z.strictObject({
  v: z.literal(1),
  snapshot: z.string().regex(ULID_PATTERN),
});

export function readComputerImport(home: string): string | undefined {
  try {
    const parsed = ComputerImport.safeParse(readPrivateJson(join(home, COMPUTER_IMPORT_FILE)));
    return parsed.success ? parsed.data.snapshot : undefined;
  } catch {
    return undefined;
  }
}

export function writeComputerImport(home: string, snapshot: string): void {
  writePrivateJson(join(home, COMPUTER_IMPORT_FILE), { v: 1, snapshot });
}

export interface ComputerImportPort {
  // The snapshot the next new computer is made from, if any; taking it uses it up.
  take(): string | undefined;
  // The new computer has its own copy of the snapshot's home folder, so the staged one goes.
  done(snapshot: string): Promise<void>;
}

export function computerImport(
  home: string,
  docker: Pick<DockerClient, "request">,
): ComputerImportPort {
  return {
    take() {
      const snapshot = readComputerImport(home);
      rmSync(join(home, COMPUTER_IMPORT_FILE), { force: true });
      return snapshot;
    },
    async done(snapshot) {
      await docker
        .request({
          method: "DELETE",
          path: `/volumes/${encodeURIComponent(`${NAME_PREFIX}home-${snapshot}`)}`,
        })
        .catch(() => console.error("the copied computer's staged home folder stays in Docker"));
    },
  };
}
