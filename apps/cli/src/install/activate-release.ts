import { ReleaseIdentity } from "../../../../packages/protocol/src/install-update.ts";
import { installedUpdateHost } from "./installed-update.ts";
import { type ImagePreparationProgress, prepareInstalledReleaseImages } from "./prepare-images.ts";
import { prepareServiceConfiguration, serviceJournalStore } from "./service-journal.ts";
import type { InstallServiceSettings } from "./service-store.ts";
import { activateUpdate, recoverUpdate } from "./update-transaction.ts";

/** Called inside withPreparedRelease's locked callback, after release promotion. Settings are
 * first-install choices only: an existing installation always retains its recorded engine,
 * Node, home and port. All downloads finish before the activation transaction stops services.
 */
export async function activateInstalledRelease(
  firstInstallSettings: InstallServiceSettings,
  identity: ReleaseIdentity,
  verifiedKeydPath: string,
  signal: AbortSignal,
  report?: (progress: ImagePreparationProgress) => void,
) {
  const settings = { ...firstInstallSettings };
  signal.throwIfAborted();
  const release = ReleaseIdentity.parse(identity);
  // Recovery has its own cleanup deadline. Do not release the caller's mutex on cancellation
  // until it settles, and do not begin image pulls or another activation after cancellation.
  const recovery = installedUpdateHost(settings, verifiedKeydPath);
  await recoverUpdate(recovery);
  signal.throwIfAborted();
  const record = await serviceJournalStore(settings).read();
  const selected = await recovery.current();
  if (selected && !record) throw new Error("Installed service configuration is missing.");
  const effective = record ? { ...record.configuration.settings } : settings;
  const candidate = await prepareServiceConfiguration(effective, release, signal);
  signal.throwIfAborted();
  await prepareInstalledReleaseImages(
    effective.state,
    candidate.release,
    effective.dockerSocket,
    signal,
    report,
  );
  signal.throwIfAborted();
  const host = installedUpdateHost(settings, verifiedKeydPath, candidate);
  const result = await activateUpdate(host, candidate.release, signal);
  signal.throwIfAborted();
  return { journal: result, configuration: candidate };
}
