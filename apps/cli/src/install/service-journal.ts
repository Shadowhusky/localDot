import {
  ServiceConfiguration,
  ServiceJournal,
  ServiceOwner,
} from "../../../../packages/protocol/src/install-services.ts";
import { ReleaseIdentity } from "../../../../packages/protocol/src/install-update.ts";
import { privateRecordStore } from "./private-record.ts";
import { serviceConfigurationId, serviceLocation } from "./service-definition.ts";
import {
  type InstallServiceSettings,
  prepareInstalledServices,
  reopenInstalledServices,
} from "./service-store.ts";

export interface ServiceScope {
  state: string;
  home: string;
  uid: number;
}
const failure = () => new Error("Installed service recovery state is unavailable or unsafe.");

export function checkedServiceConfiguration(input: unknown): ServiceConfiguration {
  const configuration = ServiceConfiguration.parse(input);
  if (
    serviceConfigurationId(configuration.settings, configuration.release) !==
    configuration.configuration
  )
    throw failure();
  return configuration;
}
const sameScope = (scope: ServiceScope, configuration: ServiceConfiguration) =>
  configuration.settings.state === scope.state &&
  configuration.settings.home === scope.home &&
  configuration.settings.uid === scope.uid;

/** Retirement must remain possible when an installed payload or Node runtime is damaged. The
 * private owner record authorizes only its unpredictable job labels; it executes no payload.
 */
export async function verifyServiceOwner(input: ServiceConfiguration) {
  const config = checkedServiceConfiguration(input);
  const owner = await privateRecordStore(
    config.settings.state,
    "service-owner.json",
    ServiceOwner,
  ).read();
  if (
    !owner ||
    owner.id !== config.settings.ownerId ||
    owner.state !== config.settings.state ||
    owner.home !== config.settings.home ||
    owner.uid !== config.settings.uid ||
    owner.uid !== process.getuid?.()
  )
    throw failure();
  return config;
}

/** Caller holds the verified-helper install lock. Reads are never cached. A completed record is
 * historical evidence only; it does not substitute for live readiness or physical retirement.
 * Current CLI environment settings cannot replace the recorded configuration during recovery.
 */
export function serviceJournalStore(scopeInput: ServiceScope) {
  const scope = { ...scopeInput };
  serviceLocation(scope.state, scope.home, scope.uid, "0".repeat(32), "0".repeat(64));
  if (scope.uid !== process.getuid?.()) throw failure();
  const records = privateRecordStore(scope.state, "service-journal.json", ServiceJournal);
  const owners = privateRecordStore(scope.state, "service-owner.json", ServiceOwner);
  async function check(input: unknown) {
    const journal = ServiceJournal.parse(input);
    const owner = await owners.read();
    if (
      !owner ||
      owner.state !== scope.state ||
      owner.home !== scope.home ||
      owner.uid !== scope.uid
    )
      throw failure();
    for (const candidate of [journal.configuration, journal.previous]) {
      if (!candidate) continue;
      const config = checkedServiceConfiguration(candidate);
      if (!sameScope(scope, config) || config.settings.ownerId !== owner.id) throw failure();
    }
    return journal;
  }
  return {
    async read(): Promise<ServiceJournal | null> {
      const record = await records.read();
      return record === null ? null : check(record);
    },
    async save(input: ServiceJournal): Promise<void> {
      const record = await check(input);
      // Refuse replacing a structurally valid record that belongs to another owner/configuration.
      const before = await records.read();
      if (before !== null) await check(before);
      await records.save(record);
    },
  };
}

/** Publish verified immutable plists and return their exact durable configuration. This performs
 * no launchd action and does not replace an active/pending service journal.
 */
export async function prepareServiceConfiguration(
  settingsInput: InstallServiceSettings,
  releaseInput: ReleaseIdentity,
  signal: AbortSignal,
): Promise<ServiceConfiguration> {
  const settings = { ...settingsInput },
    release = ReleaseIdentity.parse(releaseInput);
  const journal = await serviceJournalStore(settings).read();
  if (journal && journal.phase !== "stopped" && journal.phase !== "running") throw failure();
  const definitions = await prepareInstalledServices(settings, release, signal);
  signal.throwIfAborted();
  return checkedServiceConfiguration({
    settings: { ...settings, ownerId: definitions.keyd.ownerId },
    release,
    configuration: definitions.keyd.configuration,
  });
}

/** Recovery authority comes from the journal and private owner, then anchored files/plists are
 * reverified before any operation. No ambient port, Docker socket or user home is consulted.
 */
export async function verifyServiceConfiguration(input: ServiceConfiguration, signal: AbortSignal) {
  const config = checkedServiceConfiguration(input);
  const definitions = await reopenInstalledServices(config.settings, config.release, signal);
  if (
    definitions.keyd.ownerId !== config.settings.ownerId ||
    definitions.keyd.configuration !== config.configuration
  )
    throw failure();
  return definitions;
}
