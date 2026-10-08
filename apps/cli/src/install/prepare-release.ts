import { assembleRelease } from "./assemble-release.ts";
import { recoverAssemblyScratch } from "./assembly-scratch.ts";
import { type LockedInstallHelper, withBootstrapInstallLock } from "./bootstrap-lock.ts";
import { probeNativeDependencies } from "./native-probe.ts";
import { prepareNativeDependencies } from "./prepare-native.ts";
import { promotePreparedRelease } from "./promote-release.ts";

export type PreparedRelease = Readonly<Awaited<ReturnType<typeof promotePreparedRelease>>>;

/** A single production preparation path. The authenticated helper's kernel lock covers staging,
 * native installation, durable promotion, source cleanup and the remaining installer callback.
 * work must prepare pinned images and use the activation transaction before claiming installation.
 */
export function withPreparedRelease<T>(
  state: string,
  version: string,
  signal: AbortSignal,
  work: (release: PreparedRelease, signal: AbortSignal, helper: LockedInstallHelper) => Promise<T>,
): Promise<T> {
  return withBootstrapInstallLock(state, version, signal, async (helper) => {
    await recoverAssemblyScratch(state, signal, helper.installLifetime);
    const candidate = await assembleRelease(state, version, signal, helper.installLifetime);
    let promoted: PreparedRelease;
    try {
      const native = await prepareNativeDependencies(
        candidate,
        signal,
        undefined,
        (root, version, abort) => {
          // This production composition requires the lock capability; no absent-scope fallback.
          helper.installLifetime.inheritDescriptor();
          return probeNativeDependencies(root, version, abort, helper.installLifetime);
        },
      );
      signal.throwIfAborted();
      promoted = Object.freeze(await promotePreparedRelease(state, candidate, native, signal));
    } catch (error) {
      try {
        await candidate.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Preparation failed; candidate cleanup requires inspection.",
        );
      }
      throw error;
    }
    // Promotion copied and independently verified the tree. Its original can now be disposed
    // before service activation, reducing peak disk use and preserving single-owner cleanup.
    await candidate.dispose();
    signal.throwIfAborted();
    return work(promoted, signal, helper);
  });
}
