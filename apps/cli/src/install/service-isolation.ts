import type { ServiceConfiguration } from "../../../../packages/protocol/src/install-services.ts";
import { installImageClient } from "./image-client.ts";
import { verifyInstalledGateway } from "./network-isolation.ts";
import { prepareReleaseImages } from "./prepare-images.ts";
import { readInstalledRelease } from "./promote-release.ts";
import { verifyServiceOwner } from "./service-journal.ts";

/** Recheck all four release pins and engine identity without pulling images during readiness.
 * Cell-specific boot self-tests remain mandatory in the orchestrators; this checks the host's
 * isolated gateway behavior even when the installation has no computers yet.
 */
export async function verifyInstalledIsolation(input: ServiceConfiguration, signal: AbortSignal) {
  const config = await verifyServiceOwner(input),
    release = await readInstalledRelease(config.settings.state, config.release, signal);
  const client = installImageClient(config.settings.dockerSocket);
  const inspectOnly = {
    ...client,
    pull: async (): Promise<never> => {
      throw new Error(
        "Installed images are missing or changed; prepare the release before startup.",
      );
    },
  };
  const before = await prepareReleaseImages(release.manifest, inspectOnly, signal);
  const gateway = await verifyInstalledGateway(config, signal);
  const after = await prepareReleaseImages(release.manifest, inspectOnly, signal);
  if (
    before.engineId !== gateway.engineId ||
    before.engineId !== after.engineId ||
    JSON.stringify(before.images) !== JSON.stringify(after.images)
  )
    throw new Error("Docker changed during startup verification.");
  signal.throwIfAborted();
}
