import { join } from "node:path";
import { findDockerSocket } from "../../daemon/src/doctor-socket.ts";
import { acquireDaemonLock, lockHolder } from "../../daemon/src/lock.ts";
import { installContainerClient } from "./install/container-client.ts";
import { containHomeContainers, readContainerInventory } from "./install/container-containment.ts";
import { privateDirectory } from "./install/copy-inventory.ts";
import type { ConsoleIO, RuntimeContext } from "./runtime.ts";

// Called after service retirement. Holding the daemon lock prevents a concurrent `up` from
// starting a computer while exact owned container IDs are stopped and independently checked.
export async function runStopComputers(context: RuntimeContext, io: ConsoleIO): Promise<number> {
  let phase = "checking the localDot data folder";
  let release: (() => void) | undefined;
  try {
    context.signal.throwIfAborted();
    await privateDirectory(context.home);
    phase = "waiting for the key service to stop";
    if (lockHolder(join(context.home, "keyd", "keyd.lock")))
      throw new Error("key service is still running");
    phase = "waiting for the daemon to stop";
    release = acquireDaemonLock(join(context.home, "daemon.lock"));
    phase = "finding the Docker engine";
    const socket = findDockerSocket(context.env);
    phase = "stopping and verifying localDot containers";
    await containHomeContainers(
      context.home,
      installContainerClient(socket.path, { graceful: true }),
      () => readContainerInventory(context.home),
      context.signal,
    );
    io.out("localDot computers are stopped. Your data is kept.");
    return 0;
  } catch {
    io.err(
      `Computer shutdown could not be confirmed while ${phase}. Close localDot services, check Docker, then run localdot down again. Your data is kept.`,
    );
    return 1;
  } finally {
    release?.();
  }
}
