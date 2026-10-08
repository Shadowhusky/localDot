import type { ServiceConfiguration } from "../../../../packages/protocol/src/install-services.ts";
import { runServiceCommand } from "./service-command.ts";
import type { ServiceRole } from "./service-definition.ts";
import {
  checkedServiceConfiguration,
  type ServiceScope,
  serviceJournalStore,
  verifyServiceConfiguration,
  verifyServiceOwner,
} from "./service-journal.ts";
import type { ServiceLifecycleHost } from "./service-lifecycle.ts";
import { verifyServiceReadiness, waitForServiceReadiness } from "./service-readiness.ts";

export interface ServiceRuntimeChecks {
  // Implementations must confirm owned job absence and process exit, including lost PID replies.
  // PID alone is never authority to signal a process. Unknown outcomes reject.
  remove(
    config: ServiceConfiguration,
    role: ServiceRole,
    pid: number | null,
    signal: AbortSignal,
  ): Promise<void>;
  contain(config: ServiceConfiguration, signal: AbortSignal): Promise<void>;
  isolation(config: ServiceConfiguration, signal: AbortSignal): Promise<void>;
}
const failure = () => new Error("The installed services did not confirm the requested operation.");

/** launchctl(1) explicitly documents kickstart -p's PID output. Its print output is not an API
 * and is never parsed. A PID is only an observation to match against authenticated readiness.
 */
export function launchedServicePid(result: {
  code: number;
  stdout: string;
  stderr: string;
}): number {
  if (result.code !== 0 || result.stderr !== "" || !/^[1-9][0-9]*\n?$/.test(result.stdout))
    throw failure();
  const pid = Number(result.stdout);
  if (!Number.isSafeInteger(pid) || pid > 0x7fff_ffff) throw failure();
  return pid;
}

/** Production filesystem/launch/readiness wiring. Retirement and isolation implementations are
 * mandatory, with no success defaults. This host is not usable as a complete installer until
 * those independent runtime checks are supplied. Callers retain the install lock throughout.
 */
export function installedServiceHost(
  scopeInput: ServiceScope,
  checks: ServiceRuntimeChecks,
): ServiceLifecycleHost {
  const scope = { ...scopeInput },
    records = serviceJournalStore(scope);
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
  const command = async (
    input: ServiceConfiguration,
    role: ServiceRole,
    operation: "bootstrap" | "kickstart",
    signal: AbortSignal,
  ) => {
    const config = bound(input);
    const definitions = await verifyServiceConfiguration(config, signal);
    if (definitions[role].ownerId !== config.settings.ownerId) throw failure();
    signal.throwIfAborted();
    return runServiceCommand(definitions[role], operation, signal);
  };
  return {
    ...records,
    async verify(input, signal) {
      await verifyServiceConfiguration(bound(input), signal);
    },
    async authorizeRetirement(input, signal) {
      signal.throwIfAborted();
      await verifyServiceOwner(bound(input));
      signal.throwIfAborted();
    },
    async bootstrap(input, role, signal) {
      if ((await command(input, role, "bootstrap", signal)).code !== 0) throw failure();
    },
    async start(input, role, signal) {
      return launchedServicePid(await command(input, role, "kickstart", signal));
    },
    async remove(input, role, pid, signal) {
      const config = await verifyServiceOwner(bound(input));
      signal.throwIfAborted();
      await checks.remove(config, role, pid, signal);
    },
    async contain(input, signal) {
      const config = await verifyServiceOwner(bound(input));
      signal.throwIfAborted();
      await checks.contain(config, signal);
    },
    async healthy(input, pids, signal) {
      const config = bound(input);
      const expected = {
        home: config.settings.home,
        port: config.settings.port,
        identity: { ownerId: config.settings.ownerId, release: config.release },
        keydPid: pids.keyd,
        daemonPid: pids.daemon,
      };
      await waitForServiceReadiness(expected, signal);
      await checks.isolation(structuredClone(config), signal);
      signal.throwIfAborted();
      // Isolation can take time. Refuse a restart or readiness loss during its observation.
      await verifyServiceReadiness(expected, signal);
    },
  };
}
