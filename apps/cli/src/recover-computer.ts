import { join } from "node:path";
import { ULID_PATTERN } from "../../../packages/protocol/src/ids.ts";
import {
  ComputerFences,
  type FenceRecord,
  savedFence,
} from "../../daemon/src/agent/safety/fences.ts";
import { NativeConfirmations } from "../../daemon/src/agent/safety/native-confirmations.ts";
import { nativeTaskState } from "../../daemon/src/agent/safety/native-tasks.ts";
import { findDockerSocket } from "../../daemon/src/doctor-socket.ts";
import { acquireDaemonLock, lockHolder } from "../../daemon/src/lock.ts";
import { installContainerClient } from "./install/container-client.ts";
import { containHomeContainers, readContainerInventory } from "./install/container-containment.ts";
import { privateDirectory } from "./install/copy-inventory.ts";
import type { ConsoleIO, RuntimeContext } from "./runtime.ts";

// Explicit host-user attestation for legacy/unknown launches. This does not delete the fence,
// replace containers, or authorize new task actions. Normal replacement still verifies resources.
export async function runRecoverComputer(
  context: RuntimeContext & { cellId: string; confirmNativeExit?: true },
  io: ConsoleIO,
): Promise<number> {
  if (!ULID_PATTERN.test(context.cellId)) return 2;
  let saved: FenceRecord | undefined;
  try {
    saved = savedFence(context.home, context.cellId);
  } catch {
    // Unreadable records get the native steps; confirming re-reads them under the service lock.
  }
  const replace =
    "Open localDot and choose Replace computer: the new computer keeps this one's saved apps and files.";
  if (saved?.executor === "api") {
    const held = `This computer is held because localDot could not confirm how a task's last step or its cleanup ended. It was not a native task, so there is no native exit to confirm. ${replace}`;
    if (context.confirmNativeExit) io.err(held);
    else io.out(held);
    return context.confirmNativeExit ? 1 : 0;
  }
  if (!context.confirmNativeExit) {
    io.out(
      saved?.nativeRetired
        ? `The old native task's exit is already confirmed. ${replace}`
        : `This computer is waiting for confirmation that its old native task has stopped. If you have independently checked that it is gone, run:\n  localdot recover --cell ${context.cellId} --confirm-native-exit\nThis records your confirmation and preserves the computer's data. It does not kill a task whose identity is unknown.`,
    );
    return 0;
  }
  let release: (() => void) | undefined;
  try {
    context.signal.throwIfAborted();
    await privateDirectory(context.home);
    if (
      lockHolder(join(context.home, "keyd", "keyd.lock")) ||
      lockHolder(join(context.home, "daemon.lock"))
    )
      throw new Error("services running");
    release = acquireDaemonLock(join(context.home, "daemon.lock"));
    const fences = new ComputerFences(context.home);
    const record = fences.record(context.cellId);
    if (record?.executor !== "native") throw new Error("no native recovery record");
    if (nativeTaskState(context.home, record.cellId, record.sessionId) === "alive") {
      io.err(
        "The recorded native task still has a running process. Recovery was not confirmed. Stop the task before retrying.",
      );
      return 1;
    }
    await containHomeContainers(
      context.home,
      installContainerClient(findDockerSocket(context.env).path, { graceful: true }),
      () => readContainerInventory(context.home),
      context.signal,
    );
    context.signal.throwIfAborted();
    const confirmations = new NativeConfirmations(context.home);
    confirmations.write(record.cellId, {
      cellId: record.cellId,
      sessionId: record.sessionId,
      revision: record.revision,
      confirmedAt: new Date().toISOString(),
      source: "user-confirmed-native-exit",
    });
    fences.confirmNativeRetirement(record.cellId, record.sessionId);
    if (!fences.record(record.cellId)?.nativeRetired) throw new Error("confirmation was not saved");
    io.out(
      "Your native task exit confirmation is saved. Computer data is kept. Run localdot up, then use Replace computer to recover it.",
    );
    return 0;
  } catch {
    io.err(
      "Recovery was not confirmed. Run localdot down first, check Docker and the saved computer records, then retry. No saved data was deleted.",
    );
    return 1;
  } finally {
    release?.();
  }
}
