import { join } from "node:path";
import type { ServiceConfiguration } from "../../../packages/protocol/src/install-services.ts";
import { runBrowser } from "../../daemon/src/browser/cli.ts";
import { DockerClient } from "../../daemon/src/cells/docker.ts";
import { imagesFromEnv } from "../../daemon/src/cells/images.ts";
import { runDoctor } from "../../daemon/src/doctor.ts";
import { findDockerSocket } from "../../daemon/src/doctor-socket.ts";
import { parsePublicOrigins } from "../../daemon/src/guard.ts";
import { KeydClient, keydSocketPath } from "../../daemon/src/keyd/client.ts";
import { runOpenLink } from "../../daemon/src/open-link.ts";
import { runStop } from "../../daemon/src/stop.ts";
import type { ComputerOperation, DotsCommand, LinkKind, ReportCommand } from "./args.ts";
import { runChat } from "./chat.ts";
import { runComputer } from "./computer.ts";
import { dotEnvironment, runDots } from "./dots/runtime.ts";
import { resolveCommandContext } from "./install/command-context.ts";
import { type DefaultContext, runDefault } from "./install/default.ts";
import { runInstalledDoctor } from "./install/doctor.ts";
import { runDown } from "./install/down.ts";
import { hasInstallState } from "./install/initialize-home.ts";
import { runLogs } from "./install/logs.ts";
import { runStartAtLogin } from "./install/start-at-login.ts";
import { runUp, type UpOptions } from "./install/up.ts";
import { runUpdate, type UpdateContext } from "./install/update.ts";
import { downLocalDot, restartLocalDot, startAtLoginLocalDot, upLocalDot } from "./lifecycle.ts";
import { runLink, runRemote, runTailscale } from "./links.ts";
import { hostLocalDot } from "./local-dot.ts";
import { runRecoverComputer } from "./recover-computer.ts";
import { runReport, terminalConfirm } from "./report.ts";
import { runResetComputer } from "./reset-computer.ts";
import { printServiceLogs } from "./service-logs.ts";
import { runStatus } from "./status.ts";
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
  up(context: CommandContextInput, io: ConsoleIO, options?: UpOptions): Promise<number>;
  startAtLogin(
    context: CommandContextInput,
    operation: "on" | "off" | "status",
    io: ConsoleIO,
  ): Promise<number>;
  update(context: UpdateContext, io: ConsoleIO): Promise<number>;
  down(context: CommandContextInput, io: ConsoleIO): Promise<number>;
  restart(context: CommandContextInput, io: ConsoleIO): Promise<number>;
  status(
    context: CommandContextInput,
    io: ConsoleIO,
    options: { json: boolean; version: string },
  ): Promise<number>;
  logs(context: CommandContextInput & { follow: boolean }, io: ConsoleIO): Promise<number>;
  open(context: RuntimeContext, io: ConsoleIO, options: { qr?: true }): Promise<number>;
  link(
    context: CommandContextInput,
    io: ConsoleIO,
    options: { only?: LinkKind; qr: boolean; json: boolean },
  ): Promise<number>;
  remote(
    context: CommandContextInput,
    io: ConsoleIO,
    options: { operation: "on" | "off" | "status"; json: boolean },
  ): Promise<number>;
  tailscale(
    context: CommandContextInput,
    io: ConsoleIO,
    operation: "on" | "status",
  ): Promise<number>;
  computer(
    context: CommandContextInput,
    io: ConsoleIO,
    options: { operation: ComputerOperation; cellId?: string; json: boolean },
  ): Promise<number>;
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
  browser(
    context: RuntimeContext & { operation: "status" | "restart"; cellId?: string },
    io: ConsoleIO,
  ): Promise<number>;
  unlock(context: Pick<RuntimeContext, "home" | "signal">, io: ConsoleIO): Promise<number>;
  report(
    context: CommandContextInput,
    io: ConsoleIO,
    command: ReportCommand,
    version: string,
  ): Promise<number>;
  dots(input: CommandContextInput, command: DotsCommand, io: ConsoleIO): Promise<number>;
  dotEnvironment(input: CommandContextInput, dot: string): Promise<NodeJS.ProcessEnv>;
}

// Imports have no process side effects. Installation and lifecycle commands perform their own
// prerequisite and ownership checks. open/stop retain the existing bounded authenticated clients.
// A release-managed installation (<home>/install) starts and stops through its install journal;
// any other runs as launchd agents or systemd user units, as install.sh and development set up.
export const runtime: Runtime = {
  chat: runChat,
  context: resolveCommandContext,
  default: runDefault,
  async up(context, io, options) {
    if (await hasInstallState(context.home)) return runUp(context, io, options);
    return upLocalDot(await hostLocalDot(context), io, options);
  },
  async startAtLogin(context, operation, io) {
    if (await hasInstallState(context.home)) return runStartAtLogin(context, operation, io);
    return startAtLoginLocalDot(await hostLocalDot(context), operation, io);
  },
  update: runUpdate,
  async down(context, io) {
    if (await hasInstallState(context.home)) return runDown(context, io);
    return downLocalDot(await hostLocalDot(context), io);
  },
  restart: async (context, io) => restartLocalDot(await hostLocalDot(context), io),
  status: async (context, io, options) => runStatus(await hostLocalDot(context), io, options),
  async logs(context, io) {
    if (await hasInstallState(context.home)) return runLogs(context, io);
    return printServiceLogs(context, io);
  },
  open: (context, io, options) =>
    runOpenLink(
      {
        ...context,
        publicOrigins: parsePublicOrigins(context.env.LOCALDOT_PUBLIC_ORIGIN || undefined),
        ...options,
      },
      io,
    ),
  link: async (context, io, options) => runLink(await hostLocalDot(context), io, options),
  remote: async (context, io, options) => runRemote(await hostLocalDot(context), io, options),
  tailscale: async (context, io, operation) =>
    runTailscale(await hostLocalDot(context), io, operation),
  computer: async (context, io, options) => runComputer(await hostLocalDot(context), io, options),
  stop: (context, io) => (context.computers ? runStopComputers(context, io) : runStop(context, io)),
  resetComputer: runResetComputer,
  recover: runRecoverComputer,
  browser: runBrowser,
  dots: runDots,
  dotEnvironment,
  report: async (context, io, command, version) =>
    runReport(await hostLocalDot(context), io, command, {
      env: context.env,
      version,
      cwd: process.cwd(),
      confirm: terminalConfirm(),
    }),
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
