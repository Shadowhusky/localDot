import { join } from "node:path";
import type { ServiceConfiguration } from "../../../packages/protocol/src/install-services.ts";
import { DockerClient } from "../../daemon/src/cells/docker.ts";
import { imagesFromEnv } from "../../daemon/src/cells/images.ts";
import { runDoctor } from "../../daemon/src/doctor.ts";
import { findDockerSocket } from "../../daemon/src/doctor-socket.ts";
import { parsePublicOrigins } from "../../daemon/src/guard.ts";
import { KeydClient, keydSocketPath } from "../../daemon/src/keyd/client.ts";
import { runOpenLink } from "../../daemon/src/open-link.ts";
import { runStop } from "../../daemon/src/stop.ts";
import { runChat } from "./chat.ts";
import { resolveCommandContext } from "./install/command-context.ts";
import { type DefaultContext, runDefault } from "./install/default.ts";
import { runInstalledDoctor } from "./install/doctor.ts";
import { runDown } from "./install/down.ts";
import { runLogs } from "./install/logs.ts";
import { runStartAtLogin } from "./install/start-at-login.ts";
import { runUp, type UpOptions } from "./install/up.ts";
import { runUpdate, type UpdateContext } from "./install/update.ts";
import { runRecoverComputer } from "./recover-computer.ts";
import { runResetComputer } from "./reset-computer.ts";
import { runStopComputers } from "./stop-computers.ts";
import { passphraseRecord, runUnlock, terminalPrompt } from "./unlock.ts";

export interface CommandContextInput {
  home: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}
export interface RuntimeContext extends CommandContextInput {
  port: number;
  installed?: ServiceConfiguration;
}
export interface ConsoleIO {
  out(message: string): void;
  err(message: string): void;
}
export interface Runtime {
  chat?(context: RuntimeContext, io: ConsoleIO): Promise<number>;
  context(input: CommandContextInput): Promise<RuntimeContext>;
  default(context: DefaultContext, io: ConsoleIO): Promise<number>;
  up(
    context: Pick<RuntimeContext, "home" | "signal">,
    io: ConsoleIO,
    options?: UpOptions,
  ): Promise<number>;
  startAtLogin(
    context: Pick<RuntimeContext, "home" | "signal">,
    operation: "on" | "off" | "status",
    io: ConsoleIO,
  ): Promise<number>;
  update(context: UpdateContext, io: ConsoleIO): Promise<number>;
  down(context: Pick<RuntimeContext, "home" | "signal">, io: ConsoleIO): Promise<number>;
  logs(
    context: Pick<RuntimeContext, "home" | "signal"> & { follow: boolean },
    io: ConsoleIO,
  ): Promise<number>;
  open(context: RuntimeContext, io: ConsoleIO, options: { qr?: true }): Promise<number>;
  stop(
    context: RuntimeContext & { cellId?: string; all?: boolean; computers?: boolean },
    io: ConsoleIO,
  ): Promise<number>;
  resetComputer(
    context: RuntimeContext & { cellId: string; operation: "reset" | "status"; requestId?: string },
    io: ConsoleIO,
  ): Promise<number>;
  recover(
    context: RuntimeContext & { cellId: string; confirmNativeExit?: true },
    io: ConsoleIO,
  ): Promise<number>;
  doctor(context: RuntimeContext, io: ConsoleIO): Promise<number>;
  unlock(context: Pick<RuntimeContext, "home" | "signal">, io: ConsoleIO): Promise<number>;
}

// Imports have no process side effects. Installation and lifecycle commands perform their own
// prerequisite and ownership checks. open/stop retain the existing bounded authenticated clients.
export const runtime: Runtime = {
  chat: runChat,
  context: resolveCommandContext,
  default: runDefault,
  up: runUp,
  startAtLogin: runStartAtLogin,
  update: runUpdate,
  down: runDown,
  logs: runLogs,
  open: (context, io, options) =>
    runOpenLink(
      {
        ...context,
        publicOrigins: parsePublicOrigins(context.env.LOCALDOT_PUBLIC_ORIGIN || undefined),
        ...options,
      },
      io,
    ),
  stop: (context, io) => (context.computers ? runStopComputers(context, io) : runStop(context, io)),
  resetComputer: runResetComputer,
  recover: runRecoverComputer,
  unlock: (context, io) =>
    runUnlock(
      context.signal,
      io,
      new KeydClient(keydSocketPath(context.home)),
      terminalPrompt(),
      passphraseRecord(join(context.home, "passphrase-chosen")),
    ),
  async doctor(context, io) {
    context.signal.throwIfAborted();
    if (context.installed) return runInstalledDoctor(context, io);
    const socket = findDockerSocket(context.env);
    const images = imagesFromEnv(context.env);
    const report = await runDoctor({
      docker: new DockerClient(socket.path),
      socket,
      images,
      port: context.port,
      signal: context.signal,
      keyd: new KeydClient(keydSocketPath(context.home)),
      home: context.home,
    });
    for (const check of report.checks) {
      io.out(
        `${check.ok ? "ok  " : check.pendingAction ? "next" : "FAIL"} ${check.name.padEnd(24)} ${check.detail}`,
      );
    }
    // The first interrupt lets doctor drain its owned probe before the CLI returns.
    if (context.signal.aborted) return 130;
    if (report.ok) return 0;
    // Exit 2 means the runtime works, but the user must unlock its protected vault.
    // This must never hide a failed isolation, image, network or key-service check.
    // A stopped computer needs attention, but it must not roll back a healthy app update.
    // The computer remains fenced; its recovery notice is still printed above.
    const failed = report.checks.filter(
      (check) => !check.ok && check.pendingAction !== "recover-computer",
    );
    if (failed.length === 0) return 0;
    return failed.length > 0 && failed.every((check) => check.pendingAction === "unlock-vault")
      ? 2
      : 1;
  },
};
