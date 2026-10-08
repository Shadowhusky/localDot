import { withAcquiredNativeArchives } from "./acquire-native.ts";
import type { AssembledRelease } from "./assemble-release.ts";
import { installNativeDependencies, verifiedNativePlan } from "./install-native.ts";
import { probeNativeDependencies } from "./native-probe.ts";
import { downloadNativeArchive } from "./registry-download.ts";

/** Production composition: authenticate lock -> bounded pinned downloads -> native installation.
 * Caller owns the candidate and holds the install lock. No selection or service side effects.
 */
export async function prepareNativeDependencies(
  candidateInput: AssembledRelease,
  signal: AbortSignal,
  download = downloadNativeArchive,
  probe = probeNativeDependencies,
) {
  const candidate = Object.freeze({
    ...candidateInput,
    identity: Object.freeze({ ...candidateInput.identity }),
    metadataDigests: Object.freeze({ ...candidateInput.metadataDigests }),
  });
  const plan = await verifiedNativePlan(candidate, signal);
  return withAcquiredNativeArchives(
    candidate.directory,
    plan,
    signal,
    (archives, active) => installNativeDependencies(candidate, archives, active, probe),
    download,
  );
}
