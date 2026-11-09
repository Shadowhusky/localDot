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

/** Pulls each pinned reference, adding the bytes Docker reports for all of their layers. */
export async function pullPinnedImages(
  references: string[],
  signal: AbortSignal,
  report: (progress: PullProgress) => void,
  client: InstallImageClient = installImageClient(findDockerSocket().path, ARCHITECTURE, {
    anyEngine: true,
  }),
): Promise<void> {
  const layers = new Map<string, { current: number; total: number }>();
  try {
    for (const reference of references) {
      const [repository = "", digest = ""] = reference.split("@");
      await client.pull(
        { repository, digest, platforms: [`linux/${ARCHITECTURE}`] },
        signal,
        ({ layer, currentBytes, totalBytes, phase }) => {
          const key = `${reference} ${layer ?? ""}`;
          const known = layers.get(key);
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
          report(total ? { done, total } : {});
        },
      );
    }
  } catch (error) {
    if (error instanceof SetupFailure) throw new UpdateFailure(PROBLEMS[error.code]);
    throw error;
  }
}
