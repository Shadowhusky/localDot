import {
  type ServiceConfiguration,
  ServiceJournal,
  sameManagedService,
} from "../../../../packages/protocol/src/install-services.ts";
import { ReleaseIdentity } from "../../../../packages/protocol/src/install-update.ts";
import { prepareInstalledRuntimes } from "./prepare-runtimes.ts";
import { installedReleaseVerifier } from "./promote-release.ts";
import { releaseLayout } from "./release-layout.ts";
import { installedServiceHost } from "./service-host.ts";
import { verifyInstalledIsolation } from "./service-isolation.ts";
import { checkedServiceConfiguration, type ServiceScope } from "./service-journal.ts";
import { startServiceLifecycle, stopServiceLifecycle } from "./service-lifecycle.ts";
import { installedServiceRetirement } from "./service-retirement.ts";
import { updateJournalStore } from "./update-journal.ts";
import type { UpdateTransactionHost } from "./update-transaction.ts";

const failure = () => new Error("Installed update recovery could not be confirmed.");
const sameRelease = (a: ReleaseIdentity, b: ReleaseIdentity) =>
  sameManagedService({ ownerId: "", release: a }, { ownerId: "", release: b });

/** The caller holds the install mutex using this verified helper until all effects settle.
 * A candidate's immutable configuration must be prepared before activation. Recovery needs no
 * candidate argument: it restores the previous configuration retained in the service journal.
 * This adapter neither downloads releases/images nor deletes data or recreates computer volumes.
 * Before bootstrap it prepares stopped desktop executables under the service leases; rollback
 * uses the same path to finish interrupted preparation and restore the previous image pins.
 */
export function installedUpdateHost(
  scopeInput: ServiceScope,
  verifiedKeydPath: string,
  candidateInput?: ServiceConfiguration,
): UpdateTransactionHost {
  const scope = { ...scopeInput };
  const bound = (input: ServiceConfiguration) => {
    const config = checkedServiceConfiguration(input);
    if (
      config.settings.state !== scope.state ||
      config.settings.home !== scope.home ||
      config.settings.uid !== scope.uid
    )
      throw failure();
    return config;
  };
  const candidate = candidateInput ? bound(candidateInput) : null;
  const services = installedServiceHost(scope, {
    ...installedServiceRetirement(verifiedKeydPath),
    isolation: verifyInstalledIsolation,
  });
  const updates = updateJournalStore(scope.state);
  const layout = releaseLayout(scope.state, installedReleaseVerifier(scope.state));
  const readService = async () => {
    const raw = await services.read();
    return raw === null ? null : ServiceJournal.parse(raw);
  };
  async function configuration(input: ReleaseIdentity) {
    const release = ReleaseIdentity.parse(input);
    const record = await readService();
    const matches = [candidate, record?.configuration, record?.previous]
      .filter((config): config is ServiceConfiguration => !!config)
      .map(bound)
      .filter((config) => sameRelease(config.release, release));
    const first = matches[0];
    if (!first || matches.some((config) => JSON.stringify(config) !== JSON.stringify(first)))
      throw failure();
    return first;
  }
  async function selected(release: ReleaseIdentity) {
    const current = await layout.current();
    if (!current || !sameRelease(current, release)) throw failure();
  }
  return {
    ...updates,
    current: layout.current,
    select: layout.select,
    async verify(release, signal) {
      signal.throwIfAborted();
      const config = await configuration(release);
      await services.verify(config, signal);
      // Check the recorded engine and every pinned image before stopping the current release.
      await verifyInstalledIsolation(config, signal);
      signal.throwIfAborted();
    },
    async quiesce(signal) {
      signal.throwIfAborted();
      const record = await readService();
      if (!record) {
        const update = await updates.read();
        const current = await layout.current();
        // Before the first service intent, there have been no managed launch effects. Once an
        // earlier installation exists, missing service authority can never mean "stopped".
        if (
          !update ||
          update.previous !== null ||
          (current !== null && !sameRelease(current, update.candidate))
        )
          throw failure();
        signal.throwIfAborted();
        return;
      }
      const stopped = await stopServiceLifecycle(services, signal);
      if (stopped?.phase !== "stopped") throw failure();
      signal.throwIfAborted();
    },
    async start(release, signal) {
      signal.throwIfAborted();
      await selected(release);
      const config = await configuration(release);
      await services.verify(config, signal);
      await verifyInstalledIsolation(config, signal);
      signal.throwIfAborted();
      await prepareInstalledRuntimes(config, verifiedKeydPath, signal);
      await selected(release);
      await startServiceLifecycle(services, config, signal);
    },
    async healthy(release, signal) {
      signal.throwIfAborted();
      await selected(release);
      const expected = await configuration(release);
      const record = await readService();
      if (
        record?.phase !== "running" ||
        JSON.stringify(record.configuration) !== JSON.stringify(expected) ||
        record.jobs.keyd.phase !== "running" ||
        record.jobs.daemon.phase !== "running"
      )
        throw failure();
      await services.verify(expected, signal);
      await services.healthy(
        expected,
        { keyd: record.jobs.keyd.pid, daemon: record.jobs.daemon.pid },
        signal,
      );
      signal.throwIfAborted();
      // A historical journal and a successful HTTP probe do not cover a concurrent state change.
      await selected(release);
      if (JSON.stringify(await readService()) !== JSON.stringify(record)) throw failure();
    },
  };
}
