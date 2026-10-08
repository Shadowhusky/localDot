import { randomUUID } from "node:crypto";
import {
  type ServiceConfiguration,
  ServiceJobState,
  ServiceJournal,
  sameManagedService,
} from "../../../../packages/protocol/src/install-services.ts";
import type { ReleaseIdentity } from "../../../../packages/protocol/src/install-update.ts";
import type { ServiceRole } from "./service-definition.ts";
import { checkedServiceConfiguration } from "./service-journal.ts";

/** Hold the verified-helper install lock across all operations and recovery. Every effect must
 * honor its deadline and settle only after its transport closes. remove confirms both job removal
 * and process exit (including unknown/lost start replies); contain confirms all owned containers
 * are stopped without deleting volumes. healthy includes exact-release readiness AND isolation.
 * No callback may substitute command success, HTTP liveness, or an old receipt for these proofs.
 */
export interface ServiceLifecycleHost {
  read(): Promise<unknown | null>;
  save(record: ServiceJournal): Promise<void>;
  verify(config: ServiceConfiguration, signal: AbortSignal): Promise<void>;
  // Verify private ownership independently of executable health, so damaged payloads can retire.
  authorizeRetirement(config: ServiceConfiguration, signal: AbortSignal): Promise<void>;
  bootstrap(config: ServiceConfiguration, role: ServiceRole, signal: AbortSignal): Promise<void>;
  start(config: ServiceConfiguration, role: ServiceRole, signal: AbortSignal): Promise<number>;
  remove(
    config: ServiceConfiguration,
    role: ServiceRole,
    pid: number | null,
    signal: AbortSignal,
  ): Promise<void>;
  contain(config: ServiceConfiguration, signal: AbortSignal): Promise<void>;
  healthy(
    config: ServiceConfiguration,
    pids: { keyd: number; daemon: number },
    signal: AbortSignal,
  ): Promise<void>;
}
const failure = () => new Error("Service recovery is required before starting localDot.");
const clone = <T>(value: T): T => structuredClone(value);
const sameConfig = (a: ServiceConfiguration, b: ServiceConfiguration) =>
  a.configuration === b.configuration && JSON.stringify(a) === JSON.stringify(b);

function journal(input: unknown): ServiceJournal {
  const record = ServiceJournal.parse(input);
  const current = checkedServiceConfiguration(record.configuration);
  if (record.previous) {
    const previous = checkedServiceConfiguration(record.previous);
    for (const field of ["state", "home", "uid", "ownerId"] as const)
      if (current.settings[field] !== previous.settings[field]) throw failure();
  }
  return record;
}
async function read(host: ServiceLifecycleHost) {
  const raw = await host.read();
  return raw === null ? null : journal(raw);
}
async function save(host: ServiceLifecycleHost, input: ServiceJournal) {
  const record = journal(input);
  await host.save(clone(record));
  return record;
}
function pids(record: ServiceJournal) {
  const { keyd, daemon } = record.jobs;
  if (keyd.phase !== "running" || daemon.phase !== "running" || keyd.pid === daemon.pid)
    throw failure();
  return { keyd: keyd.pid, daemon: daemon.pid };
}
const sameAttempt = (a: ServiceJournal, b: ServiceJournal) =>
  a.id === b.id &&
  sameConfig(a.configuration, b.configuration) &&
  (a.previous === null || b.previous === null
    ? a.previous === b.previous
    : sameConfig(a.previous, b.previous));

/** Cleanup continues across a failed journal acknowledgement or one failed role. The existing
 * start intent still requires retirement; a broken disk cannot justify leaving the other role or
 * containers live. No stopped receipt is written until every effect and preceding save succeeds.
 */
async function retire(
  host: ServiceLifecycleHost,
  initial: ServiceJournal,
  signal: AbortSignal,
  writable = true,
) {
  let record = journal({ ...initial, phase: "stopping" });
  let failed = !writable;
  const persist = async () => {
    if (!writable) return;
    try {
      await save(host, record);
    } catch {
      failed = true;
    }
  };
  await persist();
  await host.authorizeRetirement(clone(record.configuration), signal);
  signal.throwIfAborted();
  for (const role of ["daemon", "keyd"] as const) {
    const before = record.jobs[role];
    const pid = before.phase === "running" || before.phase === "removing" ? before.pid : null;
    record.jobs[role] = { phase: "removing", pid };
    await persist();
    try {
      signal.throwIfAborted();
      await host.remove(clone(record.configuration), role, pid, signal);
      signal.throwIfAborted();
      record.jobs[role] = { phase: "absent" };
      await persist();
    } catch {
      failed = true;
    }
  }
  try {
    signal.throwIfAborted();
    await host.contain(clone(record.configuration), signal);
    signal.throwIfAborted();
  } catch {
    failed = true;
  }
  if (failed) throw failure();
  record = journal({ ...record, phase: "stopped" });
  try {
    return await save(host, record);
  } catch {
    const persisted = await read(host);
    if (persisted && sameAttempt(record, persisted) && persisted.phase === "stopped")
      return persisted;
    throw failure();
  }
}

export async function stopServiceLifecycle(host: ServiceLifecycleHost, signal: AbortSignal) {
  signal.throwIfAborted();
  const record = await read(host);
  if (!record) return null;
  return retire(host, record, signal);
}

/** Pending operations are retired, never resumed by repeating kickstart. A running record is
 * freshly verified before it can be reused. Call update recovery before allowing any new start.
 */
export async function recoverServiceLifecycle(host: ServiceLifecycleHost) {
  const record = await read(host);
  if (!record || record.phase === "stopped") return record;
  const signal = AbortSignal.timeout(60_000);
  if (record.phase === "running") {
    try {
      await host.verify(clone(record.configuration), signal);
      await host.healthy(clone(record.configuration), pids(record), signal);
      signal.throwIfAborted();
      return record;
    } catch {
      /* A historical running receipt cannot authorize another start. */
    }
  }
  return retire(host, record, AbortSignal.timeout(60_000));
}

/** Prepare verified plists/images before this call. The prior configuration stays in the journal
 * across a candidate activation, so rollback can find the old port/runtime/engine after a crash.
 */
export async function startServiceLifecycle(
  host: ServiceLifecycleHost,
  configInput: ServiceConfiguration,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const configuration = checkedServiceConfiguration(configInput);
  const before = await read(host);
  if (before && before.phase !== "stopped") throw failure();
  let record = journal({
    v: 1,
    id: randomUUID(),
    configuration,
    previous: before?.configuration ?? null,
    phase: "starting",
    jobs: { keyd: { phase: "absent" }, daemon: { phase: "absent" } },
  });
  await host.verify(clone(configuration), signal);
  signal.throwIfAborted();
  // A failed first save has no service effects. A persisted intent can be retired on next run.
  record = await save(host, record);
  const setJob = async (role: ServiceRole, value: ServiceJobState) => {
    record = await save(host, { ...record, jobs: { ...record.jobs, [role]: value } });
  };
  try {
    for (const role of ["keyd", "daemon"] as const) {
      signal.throwIfAborted();
      await setJob(role, { phase: "bootstrapping" });
      signal.throwIfAborted();
      await host.bootstrap(clone(configuration), role, signal);
      signal.throwIfAborted();
      await setJob(role, { phase: "loaded" });
      await setJob(role, { phase: "starting" });
      signal.throwIfAborted();
      const pid = await host.start(clone(configuration), role, signal);
      signal.throwIfAborted();
      await setJob(role, ServiceJobState.parse({ phase: "running", pid }));
    }
    record = await save(host, { ...record, phase: "validating" });
    await host.healthy(clone(configuration), pids(record), signal);
    signal.throwIfAborted();
    return await save(host, { ...record, phase: "running" });
  } catch {
    // A final save can reject after its rename. Read actual storage before deciding to retire a
    // committed start. If storage is unreadable, retain the last known intent for bounded cleanup.
    let persisted: ServiceJournal | null = null;
    try {
      persisted = await read(host);
    } catch {
      /* Cleanup still owns the known labels. */
    }
    if (persisted && sameAttempt(record, persisted) && persisted.phase === "running")
      return persisted;
    const known = persisted && sameAttempt(record, persisted) ? persisted : record;
    await retire(
      host,
      known,
      AbortSignal.timeout(60_000),
      persisted !== null && sameAttempt(record, persisted),
    );
    throw new Error("Service startup failed; the installation was stopped.");
  }
}

export function configurationForRelease(recordInput: unknown, release: ReleaseIdentity) {
  const record = journal(recordInput);
  const matches = [record.configuration, record.previous].filter(
    (config): config is ServiceConfiguration =>
      config !== null &&
      sameManagedService(
        { ownerId: config.settings.ownerId, release: config.release },
        { ownerId: config.settings.ownerId, release },
      ),
  );
  const [first, second] = matches;
  if (!first || (second && !sameConfig(first, second))) throw failure();
  return clone(first);
}
