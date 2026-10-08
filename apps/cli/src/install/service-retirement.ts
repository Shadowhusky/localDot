import { setTimeout as delay } from "node:timers/promises";
import type {
  ServiceConfiguration,
  ServiceJournal,
} from "../../../../packages/protocol/src/install-services.ts";
import { containInstalledContainers } from "./container-containment.ts";
import { keydServiceLeaseAcquirer, ServiceLeaseBusy, withServiceLease } from "./install-lock.ts";
import { recoverNativeRetiredWithLease } from "./native-recovery.ts";
import { assertNativeRetired } from "./native-retirement.ts";
import { runServiceCommand } from "./service-command.ts";
import { type ServiceRole, serviceLocation } from "./service-definition.ts";
import type { ServiceRuntimeChecks } from "./service-host.ts";
import { serviceJournalStore, verifyServiceOwner } from "./service-journal.ts";
import { observeServiceJob } from "./service-observation.ts";

const failure = () => new Error("The owned localDot services could not be confirmed stopped.");
const sameConfiguration = (a: ServiceConfiguration, b: ServiceConfiguration) =>
  JSON.stringify(a) === JSON.stringify(b);
const location = (config: ServiceConfiguration, role: ServiceRole) => {
  const s = config.settings;
  return serviceLocation(s.state, s.home, s.uid, s.ownerId, config.configuration)[role];
};
async function stopping(config: ServiceConfiguration, before?: ServiceJournal) {
  const record = await serviceJournalStore(config.settings).read();
  if (
    !record ||
    !sameConfiguration(record.configuration, config) ||
    (record.phase !== "stopping" && record.phase !== "stopped") ||
    (before &&
      (record.id !== before.id || !sameConfiguration(before.configuration, record.configuration)))
  )
    throw failure();
  return record;
}

async function withRetiredServiceLeases<T>(
  input: ServiceConfiguration,
  verifiedKeydPath: string,
  signal: AbortSignal,
  requireStopped: boolean,
  work: (recheck: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const config = await verifyServiceOwner(structuredClone(input)),
    fence = await stopping(config);
  const lease = (role: ServiceRole, run: () => Promise<T>) => {
    const s = config.settings,
      scope = { state: s.state, home: s.home, ownerId: s.ownerId, role };
    return withServiceLease(scope, signal, keydServiceLeaseAcquirer(verifiedKeydPath, scope), run);
  };
  return lease("daemon", () =>
    lease("keyd", async () => {
      let active = true,
        nativeRecovered = false;
      const recheck = async () => {
        if (!active) throw failure();
        signal.throwIfAborted();
        for (const role of ["daemon", "keyd"] as const)
          if ((await observeServiceJob(location(config, role), signal)) !== null) throw failure();
        const record = await stopping(config, fence);
        if (
          requireStopped &&
          (record.phase !== "stopped" ||
            record.jobs.daemon.phase !== "absent" ||
            record.jobs.keyd.phase !== "absent")
        )
          throw failure();
        await verifyServiceOwner(config);
        if (requireStopped) {
          if (!nativeRecovered) {
            await recoverNativeRetiredWithLease(config.settings.home, signal, verifiedKeydPath);
            nativeRecovered = true;
          }
          await assertNativeRetired(config.settings.home, signal);
        }
        const after = await stopping(config, fence);
        if (
          requireStopped &&
          (after.phase !== "stopped" ||
            after.jobs.daemon.phase !== "absent" ||
            after.jobs.keyd.phase !== "absent")
        )
          throw failure();
        signal.throwIfAborted();
        if (!active) throw failure();
      };
      try {
        await recheck();
        const result = await work(recheck);
        await recheck();
        return result;
      } finally {
        active = false;
      }
    }),
  );
}

/** Keeps both process leases for the complete operation, including cancellation/drain. The
 * caller already owns the verified-helper install mutex and must await all physical effects.
 * Recovers only recorded retired native resources, then refuses any remaining activity. Container retirement and the
 * selected release's runtime preparation remain the caller's job. */
export function withStoppedServiceLeases<T>(
  config: ServiceConfiguration,
  verifiedKeydPath: string,
  signal: AbortSignal,
  work: (recheck: () => Promise<void>) => Promise<T>,
): Promise<T> {
  return withRetiredServiceLeases(config, verifiedKeydPath, signal, true, work);
}

/** Production retirement only. The caller retains the install mutex and an independently
 * authenticated helper for this object's entire use. Never run a possibly damaged installed
 * executable to recover it. No remembered PID is used as signal authority.
 */
export function installedServiceRetirement(
  verifiedKeydPath: string,
): Pick<ServiceRuntimeChecks, "remove" | "contain"> {
  async function lease<T>(
    config: ServiceConfiguration,
    role: ServiceRole,
    signal: AbortSignal,
    work: () => Promise<T>,
  ) {
    const s = config.settings,
      scope = { state: s.state, home: s.home, ownerId: s.ownerId, role };
    return withServiceLease(scope, signal, keydServiceLeaseAcquirer(verifiedKeydPath, scope), work);
  }
  async function absent(config: ServiceConfiguration, role: ServiceRole, signal: AbortSignal) {
    if ((await observeServiceJob(location(config, role), signal)) !== null) throw failure();
  }
  return {
    async remove(input, role, _pid, callerSignal) {
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(60_000)]);
      signal.throwIfAborted();
      const config = await verifyServiceOwner(input),
        target = location(config, role);
      // A failed stopping write must not prevent best-effort removal of the known owned job.
      // Successful retirement still requires a readable, durable startup fence below.
      let before: ServiceJournal | undefined;
      try {
        before = await stopping(config);
      } catch {
        /* No success may be inferred. */
      }
      if ((await observeServiceJob(target, signal)) !== null) {
        try {
          await runServiceCommand(target, "bootout", signal);
        } catch {
          signal.throwIfAborted();
        }
      }
      // Lost/nonzero bootout replies are resolved by fresh observation, never by interpreting
      // error text. A lease prevents a late helper from starting while the final fence is checked.
      for (;;) {
        signal.throwIfAborted();
        if ((await observeServiceJob(target, signal)) === null) {
          try {
            await lease(config, role, signal, async () => {
              const fence = await stopping(config, before);
              await absent(config, role, signal);
              await verifyServiceOwner(config);
              await stopping(config, fence);
              signal.throwIfAborted();
            });
            return;
          } catch (error) {
            if (!(error instanceof ServiceLeaseBusy)) throw error;
          }
        }
        await delay(100, undefined, { signal });
      }
    },
    async contain(input, callerSignal) {
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(60_000)]);
      signal.throwIfAborted();
      const config = await verifyServiceOwner(input);
      // Both actual app processes must be gone. Hold their locks throughout containment,
      // including final inspection, so delayed starts cannot race Docker enumeration.
      await withRetiredServiceLeases(config, verifiedKeydPath, signal, false, async (recheck) => {
        await containInstalledContainers(config, signal);
        // Containers are contained even if native retirement cannot be proved. Recheck service
        // exclusion before exact recorded recovery; unknown native resources are still refused.
        await recheck();
        await recoverNativeRetiredWithLease(config.settings.home, signal, verifiedKeydPath);
        await assertNativeRetired(config.settings.home, signal);
      });
    },
  };
}
