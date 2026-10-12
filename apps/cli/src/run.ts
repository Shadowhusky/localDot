import { localdotHome } from "../../daemon/src/paths.ts";
import { HELP, parseArgs } from "./args.ts";
import type { ConsoleIO, Runtime } from "./runtime.ts";

export interface CliOptions {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  version: string;
  signal: AbortSignal;
}

export async function runCli(
  options: CliOptions,
  io: ConsoleIO,
  runtime: Runtime,
): Promise<number> {
  const command = parseArgs(options.args);
  if (!command) {
    // Invalid arguments may contain a pasted credential. Do not echo them.
    io.err("Invalid command. Run localdot --help for usage.");
    return 2;
  }
  if (command.kind === "help") {
    io.out(HELP);
    return 0;
  }
  if (command.kind === "version") {
    io.out(options.version);
    return 0;
  }
  try {
    options.signal.throwIfAborted();
    if (command.kind === "reset-computer" && command.operation === "preview") {
      io.out(
        `Reset erases computer ${command.cellId}'s home and browser profile and creates a fresh computer.`,
      );
      io.out("Shared host files, session history, settings and saved keys are retained.");
      io.out(
        `To confirm: localdot reset-computer --cell ${command.cellId} --erase-computer${command.requestId ? ` --request ${command.requestId}` : ""}`,
      );
      return 0;
    }
    if (command.kind === "default")
      return await runtime.default(
        {
          home: localdotHome(options.env),
          env: options.env,
          version: options.version,
          signal: options.signal,
        },
        io,
      );
    if (command.kind === "logs")
      return await runtime.logs(
        { home: localdotHome(options.env), signal: options.signal, follow: command.follow },
        io,
      );
    if (command.kind === "update")
      return await runtime.update(
        {
          home: localdotHome(options.env),
          signal: options.signal,
          version: command.version,
          ...(command.prepareOnly ? { prepareOnly: true } : {}),
          ...(command.installPrepared ? { installPrepared: true } : {}),
        },
        io,
      );
    if (command.kind === "down")
      return await runtime.down({ home: localdotHome(options.env), signal: options.signal }, io);
    if (command.kind === "up") {
      const context = { home: localdotHome(options.env), signal: options.signal };
      if (command.atLogin) return await runtime.up(context, io, { atLogin: true });
      if (command.fromLogin) return await runtime.up(context, io, { fromLogin: true });
      return await runtime.up(context, io);
    }
    if (command.kind === "unlock")
      return await runtime.unlock({ home: localdotHome(options.env), signal: options.signal }, io);
    if (command.kind === "start-at-login")
      return await runtime.startAtLogin(
        { home: localdotHome(options.env), signal: options.signal },
        command.operation,
        io,
      );
    if (command.kind === "doctor" && command.fix) {
      io.out("Restarting localDot and checking its computers. Saved apps and files are kept.");
      const service = { home: localdotHome(options.env), signal: options.signal };
      const stopped = await runtime.down(service, io);
      if (stopped !== 0) return stopped;
      options.signal.throwIfAborted();
      const started = await runtime.up(service, io);
      if (started !== 0) return started;
    }
    const context = await runtime.context({
      home: localdotHome(options.env),
      env: options.env,
      signal: options.signal,
    });
    options.signal.throwIfAborted();
    if (command.kind === "open")
      return await runtime.open(context, io, command.qr ? { qr: true } : {});
    if (command.kind === "stop")
      return await runtime.stop(
        {
          ...context,
          cellId: command.cellId,
          ...(command.all ? { all: true } : {}),
          ...(command.computers ? { computers: true } : {}),
        },
        io,
      );
    if (command.kind === "reset-computer" && command.operation !== "preview")
      return await runtime.resetComputer(
        {
          ...context,
          cellId: command.cellId,
          operation: command.operation,
          requestId: command.requestId,
        },
        io,
      );
    return await runtime.doctor(context, io);
  } catch {
    io.err(
      options.signal.aborted
        ? "Command interrupted."
        : "Command could not complete. Check the local daemon configuration.",
    );
    return options.signal.aborted ? 130 : 1;
  }
}
