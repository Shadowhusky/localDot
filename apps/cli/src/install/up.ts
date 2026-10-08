import { join } from "node:path";
import { runOpenLink } from "../../../daemon/src/open-link.ts";
import type { ConsoleIO, RuntimeContext } from "../runtime.ts";
import { privateDirectory } from "./copy-inventory.ts";
import { keydLockAcquirer, withInstallLock } from "./install-lock.ts";
import { installedUpdateHost } from "./installed-update.ts";
import { prepareInstalledRuntimes } from "./prepare-runtimes.ts";
import { installedReleaseVerifier, readInstalledLockHelper } from "./promote-release.ts";
import { releaseLayout } from "./release-layout.ts";
import { installedServiceHost } from "./service-host.ts";
import { verifyInstalledIsolation } from "./service-isolation.ts";
import { serviceJournalStore } from "./service-journal.ts";
import { recoverServiceLifecycle, startServiceLifecycle } from "./service-lifecycle.ts";
import { installedServiceRetirement } from "./service-retirement.ts";
import { updateJournalStore } from "./update-journal.ts";
import { recoverUpdate } from "./update-transaction.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Start an already installed release using its recorded configuration. Interrupted updates
 * roll back through the durable update/service coordinators before normal startup. This
 * does not create an installation, download files, replace recorded runtime paths or pull images.
 */
export async function runUp(
  context: Pick<RuntimeContext, "home" | "signal">,
  io: ConsoleIO,
): Promise<number> {
  try {
    const signal = context.signal;
    signal.throwIfAborted();
    await privateDirectory(context.home);
    const state = join(context.home, "install");
    await privateDirectory(state);
    const uid = process.getuid?.();
    if (!uid) throw new Error("Missing user identity");
    const scope = { state, home: context.home, uid },
      records = serviceJournalStore(scope);
    const initial = await records.read();
    if (!initial) throw new Error("Missing managed installation");
    const helper = await readInstalledLockHelper(state, initial.configuration.release, signal);
    return await withInstallLock(state, signal, keydLockAcquirer(helper.keydPath), async () => {
      const current = await records.read();
      if (!current || !same(current.configuration.release, helper.identity))
        throw new Error("Installation changed");
      const checked = await readInstalledLockHelper(state, current.configuration.release, signal);
      if (checked.keydPath !== helper.keydPath) throw new Error("Helper changed");
      io.out("Checking localDot and recovering any interrupted update…");
      await recoverUpdate(installedUpdateHost(scope, checked.keydPath));
      signal.throwIfAborted();
      const active = await records.read();
      if (!active) throw new Error("Installation setup must be completed");
      const selected = await releaseLayout(state, installedReleaseVerifier(state)).current();
      const update = await updateJournalStore(state).read();
      if (
        !selected ||
        !same(selected, active.configuration.release) ||
        !update ||
        (update.phase !== "committed" && update.phase !== "rolled-back") ||
        !same(selected, update.phase === "committed" ? update.candidate : update.previous)
      )
        throw new Error("Update recovery required");
      const host = installedServiceHost(scope, {
        ...installedServiceRetirement(checked.keydPath),
        isolation: verifyInstalledIsolation,
      });
      io.out("Checking localDot and recovering any interrupted startup…");
      const recovered = await recoverServiceLifecycle(host);
      signal.throwIfAborted();
      if (!recovered || !same(recovered.configuration, active.configuration))
        throw new Error("Service configuration changed");
      if (recovered.phase !== "running") {
        if (recovered.phase !== "stopped") throw new Error("Service recovery required");
        // Verify isolation before dispatch as well as within exact-release readiness afterward.
        await host.verify(recovered.configuration, signal);
        await verifyInstalledIsolation(recovered.configuration, signal);
        await prepareInstalledRuntimes(recovered.configuration, checked.keydPath, signal);
        if (!same(await releaseLayout(state, installedReleaseVerifier(state)).current(), selected))
          throw new Error("Selected release changed");
        io.out("Starting localDot…");
        await startServiceLifecycle(host, recovered.configuration, signal);
      }
      signal.throwIfAborted();
      io.out("localDot is ready.");
      // Mint the sign-in link while holding the same install mutex, using the recorded port.
      return runOpenLink(
        { home: scope.home, port: recovered.configuration.settings.port, signal },
        io,
      );
    });
  } catch {
    io.err(
      context.signal.aborted
        ? "Startup interrupted. Run localdot up again to recover."
        : "Startup could not be confirmed. Check the managed installation; an interrupted update requires recovery.",
    );
    return context.signal.aborted ? 130 : 1;
  }
}
