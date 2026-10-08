import { randomUUID } from "node:crypto";
import {
  ReleaseIdentity,
  UpdateJournal,
} from "../../../../packages/protocol/src/install-update.ts";

export {
  ReleaseIdentity,
  UpdateJournal,
} from "../../../../packages/protocol/src/install-update.ts";

/** Implementations must hold the installation lock for the entire call, including recovery.
 * Journal saves atomically replace and fsync both file and parent directory before resolving.
 * If a save rejects after rename, read() must report the actual durable record, never a cache.
 * Identity selects a verified release directory, never a journal-supplied executable/path.
 */
export interface UpdateTransactionHost {
  read(): Promise<unknown | null>;
  save(journal: UpdateJournal): Promise<void>;
  current(): Promise<ReleaseIdentity | null>;
  verify(release: ReleaseIdentity, signal: AbortSignal): Promise<void>;
  // Stop daemon/keyd and contain cells; resolve only after confirmed physical quiescence.
  // Keep computer volumes and user data. Unknown outcomes must reject, never count as stopped.
  quiesce(signal: AbortSignal): Promise<void>;
  // Atomic pointer change only. null removes a first-install pointer; never removes release/data.
  select(release: ReleaseIdentity | null, signal: AbortSignal): Promise<void>;
  start(release: ReleaseIdentity, signal: AbortSignal): Promise<void>;
  // Must prove this exact release is healthy, including keyd and isolation checks.
  healthy(release: ReleaseIdentity, signal: AbortSignal): Promise<void>;
}

const same = (a: ReleaseIdentity | null, b: ReleaseIdentity | null) =>
  a === null || b === null
    ? a === b
    : a.version === b.version &&
      a.packageSha256 === b.packageSha256 &&
      a.manifestSha256 === b.manifestSha256;
const terminal = (j: UpdateJournal) => j.phase === "committed" || j.phase === "rolled-back";
const failure = () =>
  new Error("Update did not complete. Recovery is required before starting localDot.");

async function savePhase(
  host: UpdateTransactionHost,
  journal: UpdateJournal,
  phase: UpdateJournal["phase"],
) {
  const next = UpdateJournal.parse({ ...journal, phase });
  await host.save(next);
  return next;
}

/** Conservative recovery: an incomplete transaction always returns to the last known release.
 * The caller's cancellation cannot interrupt cleanup. The independent deadline bounds cleanup;
 * any failure leaves a nonterminal journal, so startup must remain blocked pending recovery.
 */
async function rollback(
  host: UpdateTransactionHost,
  journal: UpdateJournal,
): Promise<UpdateJournal> {
  const signal = AbortSignal.timeout(60_000);
  const rolling = await savePhase(host, journal, "rolling-back");
  await host.quiesce(signal);
  signal.throwIfAborted();
  if (rolling.previous) await host.verify(rolling.previous, signal);
  signal.throwIfAborted();
  await host.select(rolling.previous, signal);
  signal.throwIfAborted();
  if (rolling.previous) {
    try {
      await host.start(rolling.previous, signal);
      signal.throwIfAborted();
      await host.healthy(rolling.previous, signal);
    } catch {
      // A failed start can still have launched a process. Contain before leaving recovery pending.
      await host.quiesce(AbortSignal.timeout(15_000));
      throw failure();
    }
  }
  signal.throwIfAborted();
  if (!same(await host.current(), rolling.previous)) throw failure();
  return savePhase(host, rolling, "rolled-back");
}

export async function recoverUpdate(host: UpdateTransactionHost): Promise<UpdateJournal | null> {
  const raw = await host.read();
  if (raw === null) return null;
  const journal = UpdateJournal.parse(raw);
  if (terminal(journal)) {
    const expected = journal.phase === "committed" ? journal.candidate : journal.previous;
    if (!same(await host.current(), expected)) throw failure();
    return journal;
  }
  return rollback(host, journal);
}

/** Staging, authenticated provenance, dependency installation and image pulls precede this call.
 * This coordinator supplies ordering/recovery, not those checks or a production service adapter.
 * No startup path may bypass recoverUpdate when a nonterminal journal exists.
 */
export async function activateUpdate(
  host: UpdateTransactionHost,
  candidateInput: ReleaseIdentity,
  signal: AbortSignal,
): Promise<UpdateJournal> {
  signal.throwIfAborted();
  const candidate = ReleaseIdentity.parse(candidateInput);
  const existing = await host.read();
  if (existing !== null && !terminal(UpdateJournal.parse(existing))) throw failure();
  const previous = ReleaseIdentity.nullable().parse(await host.current());
  if (existing !== null) {
    const prior = UpdateJournal.parse(existing);
    if (!same(previous, prior.phase === "committed" ? prior.candidate : prior.previous))
      throw failure();
  }
  if (same(previous, candidate)) throw new Error("This release is already selected.");
  await host.verify(candidate, signal);
  signal.throwIfAborted();
  if (previous) await host.verify(previous, signal);
  signal.throwIfAborted();
  const journal: UpdateJournal = {
    v: 1,
    id: randomUUID(),
    previous,
    candidate,
    phase: "prepared",
  };
  // Failure here has no service effects. A possibly persisted prepared record is recovered next run.
  await host.save(journal);
  try {
    await savePhase(host, journal, "quiescing");
    signal.throwIfAborted();
    await host.quiesce(signal);
    signal.throwIfAborted();
    await savePhase(host, journal, "activating");
    await host.select(candidate, signal);
    signal.throwIfAborted();
    await savePhase(host, journal, "validating");
    await host.start(candidate, signal);
    signal.throwIfAborted();
    await host.healthy(candidate, signal);
    signal.throwIfAborted();
    if (!same(await host.current(), candidate)) throw failure();
    return await savePhase(host, journal, "committed");
  } catch {
    // Re-read rather than assume a failed save did not persist. An uncertain commit must not
    // silently roll back a committed release or start either release on unverifiable storage.
    let persisted: UpdateJournal;
    try {
      persisted = UpdateJournal.parse(await host.read());
    } catch {
      await host.quiesce(AbortSignal.timeout(15_000));
      throw failure();
    }
    if (
      persisted.id !== journal.id ||
      !same(persisted.previous, previous) ||
      !same(persisted.candidate, candidate)
    ) {
      await host.quiesce(AbortSignal.timeout(15_000));
      throw failure();
    }
    if (persisted.phase === "committed") {
      if (!same(await host.current(), candidate)) throw failure();
      return persisted;
    }
    await rollback(host, persisted);
    throw new Error("Update failed; the previous installation was restored.");
  }
}
