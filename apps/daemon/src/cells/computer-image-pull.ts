import {
  type InstallImageClient,
  installImageClient,
} from "../../../cli/src/install/image-client.ts";
import { SetupFailure } from "../../../cli/src/install/setup-failure.ts";
import { findDockerSocket } from "../doctor-socket.ts";
import { UpdateFailure } from "../updates/progress.ts";
import type { PullProgress } from "./computer-update.ts";

const ARCHITECTURE = process.arch === "arm64" ? "arm64" : "amd64";
const PROBLEMS = {
  "network-unavailable": "network",
  "storage-full": "disk",
  "storage-read-only": "disk",
  "permission-denied": "docker",
  "docker-unavailable": "docker",
} as const;

/** Pulls each pinned reference, adding the bytes Docker reports for all of their layers. Docker
 * only gives a layer's size as it starts, so a total comes once nothing is left to discover. */
export async function pullPinnedImages(
  references: string[],
  signal: AbortSignal,
  report: (progress: PullProgress) => void,
  client: InstallImageClient = installImageClient(findDockerSocket().path, ARCHITECTURE, {
    anyEngine: true,
  }),
): Promise<void> {
  const layers = new Map<string, { current: number; total: number }>();
  const waiting = new Set<string>();
  try {
    for (const [index, reference] of references.entries()) {
      const [repository = "", digest = ""] = reference.split("@");
      waiting.clear();
      await client.pull(
        { repository, digest, platforms: [`linux/${ARCHITECTURE}`] },
        signal,
        ({ layer, currentBytes, totalBytes, phase, queued }) => {
          const key = `${reference} ${layer ?? ""}`;
          const known = layers.get(key);
          if (queued) waiting.add(key);
          else if (phase !== "downloading" || totalBytes) waiting.delete(key);
          if (phase === "downloading" && currentBytes !== undefined && totalBytes)
            layers.set(key, { current: currentBytes, total: totalBytes });
          else if (known && (phase === "verifying" || phase === "extracting"))
            known.current = known.total;
          let done = 0,
            total = 0;
          for (const bytes of layers.values()) {
            done += bytes.current;
            total += bytes.total;
          }
          const sized = index === references.length - 1 && waiting.size === 0;
          report(total && sized ? { done, total } : done ? { done } : {});
        },
      );
    }
  } catch (error) {
    if (error instanceof SetupFailure) throw new UpdateFailure(PROBLEMS[error.code]);
    throw error;
  }
}
