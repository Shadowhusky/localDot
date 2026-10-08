import type { ServiceConfiguration } from "../../../packages/protocol/src/install-services.ts";
import { DockerClient } from "../../daemon/src/cells/docker.ts";
import { imagesFromEnv } from "../../daemon/src/cells/images.ts";
import { runDoctor } from "../../daemon/src/doctor.ts";
import { findDockerSocket } from "../../daemon/src/doctor-socket.ts";
import { KeydClient, keydSocketPath } from "../../daemon/src/keyd/client.ts";
import { runOpenLink } from "../../daemon/src/open-link.ts";
import { runStop } from "../../daemon/src/stop.ts";
import { resolveCommandContext } from "./install/command-context.ts";
import { type DefaultContext, runDefault } from "./install/default.ts";
import { runInstalledDoctor } from "./install/doctor.ts";
import { runDown } from "./install/down.ts";
import { runLogs } from "./install/logs.ts";
import { runUp } from "./install/up.ts";
import { runUpdate, type UpdateContext } from "./install/update.ts";
import { runResetComputer } from "./reset-computer.ts";

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
  context(input: CommandContextInput): Promise<RuntimeContext>;
  default(context: DefaultContext, io: ConsoleIO): Promise<number>;
  up(context: Pick<RuntimeContext, "home" | "signal">, io: ConsoleIO): Promise<number>;
  update(context: UpdateContext, io: ConsoleIO): Promise<number>;
  down(context: Pick<RuntimeContext, "home" | "signal">, io: ConsoleIO): Promise<number>;
  logs(
    context: Pick<RuntimeContext, "home" | "signal"> & { follow: boolean },
    io: ConsoleIO,
  ): Promise<number>;
  open(context: RuntimeContext, io: ConsoleIO): Promise<number>;
  stop(context: RuntimeContext & { cellId?: string }, io: ConsoleIO): Promise<number>;
  resetComputer(
    context: RuntimeContext & { cellId: string; operation: "reset" | "status"; requestId?: string },
    io: ConsoleIO,
  ): Promise<number>;
  doctor(context: RuntimeContext, io: ConsoleIO): Promise<number>;
}

// Imports have no process side effects. Installation and lifecycle commands perform their own
// prerequisite and ownership checks. open/stop retain the existing bounded authenticated clients.
export const runtime: Runtime = {
  context: resolveCommandContext,
  default: runDefault,
  up: runUp,
  update: runUpdate,
  down: runDown,
  logs: runLogs,
  open: runOpenLink,
  stop: runStop,
  resetComputer: runResetComputer,
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
    });
    for (const check of report.checks) {
      io.out(`${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(24)} ${check.detail}`);
    }
    // The first interrupt lets doctor drain its owned probe before the CLI returns.
    return context.signal.aborted ? 130 : report.ok ? 0 : 1;
  },
};
