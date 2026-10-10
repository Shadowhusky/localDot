import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import {
  AppUpdateRecord,
  compareReleaseVersions,
  DEFAULT_APP_UPDATES,
  PreparedAppUpdate,
} from "../../../../packages/protocol/src/app-update.ts";
import type { ServiceConfiguration } from "../../../../packages/protocol/src/install-services.ts";
import { UpdateJournal } from "../../../../packages/protocol/src/install-update.ts";
import type { ConsoleIO } from "../runtime.ts";
import { activateInstalledRelease } from "./activate-release.ts";
import { prepareInstalledReleaseImages } from "./prepare-images.ts";
import { withPreparedRelease } from "./prepare-release.ts";
import { privateRecordStore } from "./private-record.ts";
import { readInstalledLockHelper, readInstalledRelease } from "./promote-release.ts";
import { serviceJournalStore } from "./service-journal.ts";
import { updateJournalStore } from "./update-journal.ts";

export const preparedAppUpdateStore = (state: string) =>
  privateRecordStore(state, "prepared-app-update.json", PreparedAppUpdate);
export const appUpdateRecordStore = (state: string) =>
  privateRecordStore(state, "app-update.json", AppUpdateRecord);

/** Background preparation NEVER recovers, stops or starts services. An unresolved transaction
 * requires explicit recovery. The existing publisher/native signature/image checks all apply. */
export async function prepareBackgroundUpdate(
  input: { home: string; version: string; signal: AbortSignal },
  io: ConsoleIO,
): Promise<number> {
  try {
    const state = join(input.home, "install");
    await withPreparedRelease(state, input.version, input.signal, async (release, signal) => {
      const current = await serviceJournalStore({
        state,
        home: input.home,
        uid: process.getuid?.() ?? -1,
      }).read();
      const journal = UpdateJournal.parse(await updateJournalStore(state).read());
      if (
        !current ||
        !["committed", "rolled-back"].includes(journal.phase) ||
        !equal(
          current.configuration.release,
          journal.phase === "committed" ? journal.candidate : journal.previous,
        ) ||
        compareReleaseVersions(release.identity.version, current.configuration.release.version) <= 0
      )
        throw new Error("Cannot prepare update");
      await prepareInstalledReleaseImages(
        state,
        release.identity,
        current.configuration.settings.dockerSocket,
        signal,
      );
      signal.throwIfAborted();
      await preparedAppUpdateStore(state).save({
        v: 1,
        previous: current.configuration.release,
        candidate: release.identity,
      });
    });
    io.out("Update downloaded and verified. It will not interrupt the running app.");
    return 0;
  } catch {
    io.err("The update couldn't be prepared. Your current app has not been changed.");
    return input.signal.aborted ? 130 : 1;
  }
}

/** Caller holds the verified install lock and has recovered services to STOPPED. Do not invoke
 * for a running installation, including an idle one. Consume the attempt before activation so
 * rollback cannot create a launch loop. Optional update damage never prevents ordinary startup. */
export async function applyPreparedOnLaunch(
  config: ServiceConfiguration,
  signal: AbortSignal,
  io: ConsoleIO,
): Promise<ServiceConfiguration | null> {
  const { state } = config.settings;
  let pending: ReturnType<typeof PreparedAppUpdate.parse> | null;
  try {
    const preferences =
      (await appUpdateRecordStore(state).read())?.preferences ?? DEFAULT_APP_UPDATES;
    if (!preferences.installOnLaunch) return null;
    pending = await preparedAppUpdateStore(state).read();
    if (
      !pending?.candidate ||
      !equal(pending.previous, config.release) ||
      compareReleaseVersions(pending.candidate.version, config.release.version) <= 0
    )
      return null;
    const services = await serviceJournalStore(config.settings).read();
    if (services?.phase !== "stopped" || !equal(services.configuration, config)) return null;
    await readInstalledRelease(state, pending.candidate, signal);
  } catch {
    signal.throwIfAborted();
    io.err("The prepared update is unavailable. Starting your current version.");
    return null;
  }
  const candidate = pending.candidate;
  if (!candidate) return null;
  // After this point, errors must propagate to the normal update recovery path, not start an
  // assumed old configuration after a possibly successful pointer change.
  await preparedAppUpdateStore(state).save({ ...pending, candidate: null });
  const helper = await readInstalledLockHelper(state, candidate, signal);
  io.out(`Installing verified localDot ${candidate.version} before startup…`);
  return (await activateInstalledRelease(config.settings, candidate, helper.keydPath, signal))
    .configuration;
}
