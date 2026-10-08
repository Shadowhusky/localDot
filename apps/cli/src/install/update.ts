import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { UpdateJournal } from "../../../../packages/protocol/src/install-update.ts";
import { RELEASE_VERSION } from "../../../../packages/protocol/src/release.ts";
import { runOpenLink } from "../../../daemon/src/open-link.ts";
import type { ConsoleIO } from "../runtime.ts";
import { activateInstalledRelease } from "./activate-release.ts";
import { hasInstallState } from "./initialize-home.ts";
import { keydLockAcquirer, withInstallLock } from "./install-lock.ts";
import { installedUpdateHost } from "./installed-update.ts";
import { withPreparedRelease } from "./prepare-release.ts";
import { readInstalledLockHelper } from "./promote-release.ts";
import { latestReleaseVersion } from "./registry-download.ts";
import { serviceJournalStore } from "./service-journal.ts";
import { runUp } from "./up.ts";
import { recoverUpdate } from "./update-transaction.ts";

export interface UpdateContext {
  home: string;
  signal: AbortSignal;
  version?: string;
}
const failure = () => new Error("Update preparation could not be confirmed.");
function valid(version: string) {
  if (version.length > 64 || !RELEASE_VERSION.test(version)) throw failure();
  return version;
}
/** Compare the deliberately small supported grammar without number precision loss. */
export function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string) =>
    valid(value)
      .split(/\.|-rc\./)
      .map(BigInt);
  const a = parse(left),
    b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0n) > (b[i] ?? 0n) ? 1 : -1;
  }
  if (a.length !== b.length) return a.length < b.length ? 1 : -1;
  return a[3] === b[3] ? 0 : (a[3] ?? 0n) > (b[3] ?? 0n) ? 1 : -1;
}

/** No ambient port, socket, registry or credential configuration replaces installed authority.
 * Recovery is offline first. All preparation/activation work drains inside its helper lock. */
export async function runUpdate(input: UpdateContext, io: ConsoleIO): Promise<number> {
  const { home, signal } = input,
    requested = input.version;
  try {
    signal.throwIfAborted();
    if (requested !== undefined) valid(requested);
    if (!(await hasInstallState(home))) {
      io.err("localDot is not installed. Run localdot first.");
      return 1;
    }
    const uid = process.getuid?.();
    if (!uid) throw failure();
    const scope = { home, state: join(home, "install"), uid },
      records = serviceJournalStore(scope);
    const initial = await records.read();
    if (!initial) throw failure();
    const helper = await readInstalledLockHelper(
      scope.state,
      initial.configuration.release,
      signal,
    );
    let updateSnapshot: UpdateJournal | undefined;
    io.out("Checking the installed release and recovering any interrupted update…");
    const observed = await withInstallLock(
      scope.state,
      signal,
      keydLockAcquirer(helper.keydPath),
      async () => {
        const current = await records.read();
        if (!current || !equal(current.configuration.release, helper.identity)) throw failure();
        const verified = await readInstalledLockHelper(
          scope.state,
          current.configuration.release,
          signal,
        );
        if (verified.keydPath !== helper.keydPath) throw failure();
        const host = installedUpdateHost(scope, verified.keydPath);
        await recoverUpdate(host);
        signal.throwIfAborted();
        const recovered = await records.read();
        if (!recovered || !equal(await host.current(), recovered.configuration.release))
          throw failure();
        updateSnapshot = UpdateJournal.parse(await host.read());
        if (
          (updateSnapshot.phase !== "committed" && updateSnapshot.phase !== "rolled-back") ||
          !equal(
            recovered.configuration.release,
            updateSnapshot.phase === "committed"
              ? updateSnapshot.candidate
              : updateSnapshot.previous,
          )
        )
          throw failure();
        return structuredClone(recovered.configuration);
      },
    );
    signal.throwIfAborted();
    io.out(
      requested
        ? `Checking localDot ${requested}…`
        : "Checking for the latest stable localDot release…",
    );
    const version = valid(requested ?? (await latestReleaseVersion(signal)));
    signal.throwIfAborted();
    const order = compareReleaseVersions(version, observed.release.version);
    if (order < 0) {
      io.err(
        "The selected release is older than the installed release. Update does not downgrade localDot.",
      );
      return 1;
    }
    if (order === 0) {
      const result = await runUp({ home, signal }, io);
      if (result === 0 && !signal.aborted) io.out("localDot is up to date and ready.");
      return signal.aborted ? 130 : result;
    }
    io.out(`Preparing verified localDot ${version}…`);
    const result = await withPreparedRelease(
      scope.state,
      version,
      signal,
      async (release, active, lockedHelper) => {
        active.throwIfAborted();
        const current = await records.read();
        // Another updater can run between the two locks. Never use the old comparison/settings
        // to downgrade or silently take over its unfinished operation.
        if (
          !current ||
          !equal(current.configuration, observed) ||
          release.identity.version !== version
        )
          throw failure();
        const host = installedUpdateHost(scope, lockedHelper.keydPath);
        if (
          !equal(await host.current(), observed.release) ||
          !equal(await host.read(), updateSnapshot)
        )
          throw failure();
        let lastProgress = "";
        const activated = await activateInstalledRelease(
          observed.settings,
          release.identity,
          lockedHelper.keydPath,
          active,
          (progress) => {
            const message = `Preparing ${progress.role}: ${progress.phase}…`;
            if (message !== lastProgress) {
              io.out(message);
              lastProgress = message;
            }
          },
        );
        active.throwIfAborted();
        io.out(`Updated to localDot ${version}. The app is ready.`);
        return runOpenLink(
          { home, port: activated.configuration.settings.port, signal: active },
          io,
        );
      },
    );
    return signal.aborted ? 130 : result;
  } catch {
    io.err(
      signal.aborted
        ? "Update interrupted. Run localdot up to check or recover the installed app."
        : "Update did not complete. Run localdot up to check or recover the installed app, then retry localdot update.",
    );
    return signal.aborted ? 130 : 1;
  }
}
