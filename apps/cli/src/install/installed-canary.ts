import { ulid } from "../../../../packages/protocol/src/ids.ts";
import type { ServiceConfiguration } from "../../../../packages/protocol/src/install-services.ts";
import { imageRef, type ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { prepareCanaryArtifactControl, verifyCanaryFinalArtifacts } from "./canary-artifacts.ts";
import { readCanaryAssets } from "./canary-assets.ts";
import { withCanaryContainerLogs } from "./canary-container-logs.ts";
import { installedCanaryOperationContext } from "./canary-context.ts";
import { runCanaryDesktopScan } from "./canary-execution.ts";
import { recoverCanaryOperation, withCanaryOperation } from "./canary-operation.ts";
import { withCanaryProcess } from "./canary-process.ts";
import { waitCanaryReadiness } from "./canary-readiness.ts";
import { createCanaryTopology } from "./canary-topology.ts";
import { canaryTopologyClient } from "./canary-topology-client.ts";

export interface InstalledCanaryInput {
  configuration: ServiceConfiguration;
  verifiedKeydPath: string;
  releaseDirectory: string;
  manifest: ReleaseManifest;
  engineId: string;
  imageIds: { desktop: string; gate: string };
}

/** Caller holds the install mutex, has authenticated the selected release/helper
 * and checked image/engine prerequisites. Success is returned only after all
 * evidence is collected, the helper actually exits and durable cleanup finishes.
 * This uses a separate synthetic-key gateway, never the installed user's vault. */
export async function runInstalledCanary(input: InstalledCanaryInput, signal: AbortSignal) {
  try {
    signal.throwIfAborted();
    const { configuration, verifiedKeydPath, releaseDirectory, manifest, engineId, imageIds } =
      structuredClone(input);
    const context = await installedCanaryOperationContext(configuration, verifiedKeydPath);
    const identity = { owner: configuration.settings.ownerId, engineId };
    // Recover only the durable prior operation before creating another one.
    await recoverCanaryOperation(context, identity, signal);
    const assets = await readCanaryAssets(releaseDirectory, manifest, signal);
    const socket = configuration.settings.dockerSocket;
    return await withCanaryOperation(
      context,
      {
        ...identity,
        cellId: ulid(),
        images: {
          desktop: { ref: imageRef(manifest.images.desktop), id: imageIds.desktop },
          gate: { ref: imageRef(manifest.images.gate), id: imageIds.gate },
        },
      },
      signal,
      async (journal, directory, directoryDescriptor) => {
        const operation = journal.snapshot();
        const completed = await withCanaryProcess(
          {
            verifiedKeydPath,
            directory,
            directoryDescriptor,
            runId: operation.runId,
            cellId: operation.cellId,
          },
          signal,
          async (ready, active) => {
            const control = await prepareCanaryArtifactControl(
              directory,
              journal.snapshot(),
              active,
            );
            const client = canaryTopologyClient(socket, journal.snapshot(), ready);
            const topology = await createCanaryTopology(journal, ready, client, active);
            await waitCanaryReadiness(journal.snapshot(), topology, client, active);
            const evidence = await withCanaryContainerLogs(
              socket,
              journal.snapshot(),
              active,
              (running) => runCanaryDesktopScan(socket, journal.snapshot(), ready, assets, running),
            );
            return { ready, control, evidence };
          },
        );
        const { ready, control, evidence } = completed.value;
        const artifacts = await verifyCanaryFinalArtifacts(
          directory,
          journal.snapshot(),
          ready,
          completed.receipt,
          control,
          completed.stderr,
          evidence.logs,
          signal,
        );
        return { scan: evidence.value, artifacts };
      },
    );
  } catch {
    throw new Error(
      "The installed credential diagnostic failed or its cleanup requires recovery. Retry localdot doctor after checking Docker Desktop.",
    );
  }
}
