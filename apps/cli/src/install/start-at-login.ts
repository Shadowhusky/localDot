import { join } from "node:path";
import type { ConsoleIO, RuntimeContext } from "../runtime.ts";
import { keydLockAcquirer, withInstallLock } from "./install-lock.ts";
import {
  type LoginAgentHost,
  nodeLoginAgentHost,
  setStartAtLogin,
  startAtLoginStore,
} from "./login-agent.ts";
import { readInstalledLockHelper } from "./promote-release.ts";
import { serviceJournalStore, verifyServiceConfiguration } from "./service-journal.ts";

/** Changes only the login agent. Never starts, stops or retires the services, so the running
 * daemon can call it from Settings without risking its own process.
 */
export async function runStartAtLogin(
  context: Pick<RuntimeContext, "home" | "signal">,
  operation: "on" | "off" | "status",
  io: ConsoleIO,
  host?: LoginAgentHost,
): Promise<number> {
  const { signal } = context;
  try {
    const uid = process.getuid?.();
    if (!uid) throw new Error("Missing user identity");
    const state = join(context.home, "install");
    if (operation === "status") {
      io.out((await startAtLoginStore(state).read())?.enabled ? "on" : "off");
      return 0;
    }
    const scope = { state, home: context.home, uid },
      records = serviceJournalStore(scope);
    const initial = await records.read();
    if (!initial) throw new Error("Missing managed installation");
    const helper = await readInstalledLockHelper(state, initial.configuration.release, signal);
    const result = await withInstallLock(
      state,
      signal,
      keydLockAcquirer(helper.keydPath),
      async () => {
        const current = await records.read();
        if (!current) throw new Error("Installation changed");
        await verifyServiceConfiguration(current.configuration, signal);
        return setStartAtLogin(
          current.configuration,
          operation === "on",
          host ?? nodeLoginAgentHost(uid),
          signal,
        );
      },
    );
    io.out(
      result === "on"
        ? "localDot will start when you log in."
        : "localDot will not start when you log in.",
    );
    return 0;
  } catch {
    io.err(
      signal.aborted
        ? "Interrupted. Start at login is unchanged or unconfirmed; run localdot start-at-login status."
        : "Start at login could not be changed. Another localDot operation may be running; try again.",
    );
    return signal.aborted ? 130 : 1;
  }
}
