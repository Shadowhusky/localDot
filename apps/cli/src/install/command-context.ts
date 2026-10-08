import { join } from "node:path";
import { parsePort } from "../../../daemon/src/port.ts";
import type { CommandContextInput, RuntimeContext } from "../runtime.ts";
import { hasInstallState } from "./initialize-home.ts";
import { serviceJournalStore } from "./service-journal.ts";

/** Read recorded routing without starting services or needing a healthy executable. In particular,
 * Stop must not wait behind the install lock or depend on a signature/payload check to find its daemon.
 */
export async function resolveCommandContext(input: CommandContextInput): Promise<RuntimeContext> {
  const { home, signal } = input,
    env = { ...input.env };
  signal.throwIfAborted();
  const managed = await hasInstallState(home);
  signal.throwIfAborted();
  if (!managed) return { home, signal, env, port: parsePort(env.LOCALDOT_PORT) };
  const uid = process.getuid?.();
  if (!uid) throw new Error("Missing installation user");
  const journal = await serviceJournalStore({ home, state: join(home, "install"), uid }).read();
  if (!journal) throw new Error("Managed installation settings are unavailable");
  signal.throwIfAborted();
  const installed = journal.configuration,
    settings = installed.settings;
  return {
    home,
    signal,
    installed,
    port: settings.port,
    env: {
      ...env,
      LOCALDOT_PORT: String(settings.port),
      DOCKER_HOST: `unix://${settings.dockerSocket}`,
    },
  };
}
