import { join } from "node:path";
import type { ConsoleIO, RuntimeContext } from "../runtime.ts";
import { privateDirectory } from "./copy-inventory.ts";
import { keydLockAcquirer, withInstallLock } from "./install-lock.ts";
import { readInstalledLockHelper } from "./promote-release.ts";
import { serviceJournalStore, verifyServiceOwner } from "./service-journal.ts";
import { stopServiceLifecycle } from "./service-lifecycle.ts";
import { installedServiceRetirement } from "./service-retirement.ts";

/** Managed state lives at <LOCALDOT_HOME>/install. No automatic network recovery, ambient Docker
 * selection, Node execution or update rollback/start occurs during down. A broken helper requires
 * explicit installer recovery; it must never be executed merely because it occupies the old path.
 */
export async function runDown(
  context: Pick<RuntimeContext, "home" | "signal">,
  io: ConsoleIO,
): Promise<number> {
  try {
    context.signal.throwIfAborted();
    await privateDirectory(context.home);
    const state = join(context.home, "install");
    await privateDirectory(state);
    const uid = process.getuid?.();
    if (!uid) throw new Error("Missing user identity");
    const records = serviceJournalStore({ state, home: context.home, uid });
    const initial = await records.read();
    if (!initial) throw new Error("Missing managed service record");
    const helper = await readInstalledLockHelper(
      state,
      initial.configuration.release,
      context.signal,
    );
    await withInstallLock(state, context.signal, keydLockAcquirer(helper.keydPath), async () => {
      const current = await records.read();
      if (!current) throw new Error("Missing managed service record");
      // Reverify after acquiring ownership; a concurrent installer may have changed the journal
      // while the read-only pre-lock verification was running. Never retire a stale configuration.
      if (JSON.stringify(current.configuration.release) !== JSON.stringify(helper.identity))
        throw new Error("Installation changed");
      const checked = await readInstalledLockHelper(
        state,
        current.configuration.release,
        context.signal,
      );
      if (checked.keydPath !== helper.keydPath) throw new Error("Helper changed");
      const retirement = installedServiceRetirement(checked.keydPath);
      const noStart = async (): Promise<never> => {
        throw new Error("Down cannot start a service");
      };
      io.out("Stopping localDot services and computers…");
      const result = await stopServiceLifecycle(
        {
          ...records,
          ...retirement,
          authorizeRetirement: async (config) => {
            await verifyServiceOwner(config);
          },
          verify: noStart,
          bootstrap: noStart,
          start: noStart,
          healthy: noStart,
        },
        context.signal,
      );
      if (result?.phase !== "stopped") throw new Error("Shutdown unconfirmed");
      context.signal.throwIfAborted();
    });
    io.out("localDot is down. Computer data has been preserved.");
    return 0;
  } catch {
    io.err(
      context.signal.aborted
        ? "Shutdown interrupted; run localdot down again to confirm shutdown."
        : "Shutdown is unconfirmed. Check the managed installation and run localdot down again.",
    );
    return context.signal.aborted ? 130 : 1;
  }
}
