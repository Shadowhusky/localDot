import { localdotHome } from "../../daemon/src/paths.ts";
import { HELP, parseArgs, usageHint } from "./args.ts";
import { DotsCommandError } from "./dots/commands.ts";
import { CommandError } from "./local-dot.ts";
import type { ConsoleIO, Runtime } from "./runtime.ts";

export interface CliOptions {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  version: string;
  signal: AbortSignal;
}

export async function runCli(
  cliOptions: CliOptions,
  io: ConsoleIO,
  runtime: Runtime,
): Promise<number> {
  let options = cliOptions;
  const command = parseArgs(options.args);
  if (!command) {
    // Invalid arguments may contain a pasted credential. Do not echo them.
    io.err(`Invalid command. ${usageHint(options.args)}`);
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
    if (command.kind === "dots")
      return await runtime.dots(
        { home: localdotHome(options.env), env: options.env, signal: options.signal },
        command.dots,
        io,
      );
    if (command.dot) {
      const main = { home: localdotHome(options.env), env: options.env, signal: options.signal };
      if (command.kind === "up" || command.kind === "down")
        return await runtime.dots(
          main,
          { operation: command.kind === "up" ? "start" : "stop", dot: command.dot },
          io,
        );
      options = {
        ...options,
        env: { ...options.env, ...(await runtime.dotEnvironment(main, command.dot)) },
      };
    }
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
    const input = { home: localdotHome(options.env), env: options.env, signal: options.signal };
    switch (command.kind) {
      case "restart":
        return await runtime.restart(input, io);
      case "status":
        return await runtime.status(input, io, { json: !!command.json, version: options.version });
      case "link":
        return await runtime.link(input, io, {
          ...(command.only ? { only: command.only } : {}),
          qr: !!command.qr,
          json: !!command.json,
        });
      case "remote":
        return await runtime.remote(input, io, {
          operation: command.operation,
          json: !!command.json,
        });
      case "tailscale":
        return await runtime.tailscale(input, io, command.operation);
      case "computer":
        return await runtime.computer(input, io, {
          operation: command.operation,
          ...(command.cellId ? { cellId: command.cellId } : {}),
          json: !!command.json,
        });
      case "report":
        return await runtime.report(input, io, command.report, options.version);
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
      return await runtime.logs({ ...input, follow: command.follow }, io);
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
    if (command.kind === "down") return await runtime.down(input, io);
    if (command.kind === "up") {
      if (command.atLogin) return await runtime.up(input, io, { atLogin: true });
      if (command.fromLogin) return await runtime.up(input, io, { fromLogin: true });
      return await runtime.up(input, io);
    }
    if (command.kind === "unlock")
      return await runtime.unlock({ home: localdotHome(options.env), signal: options.signal }, io);
    if (command.kind === "start-at-login")
      return await runtime.startAtLogin(input, command.operation, io);
    if (command.kind === "doctor" && command.fix) {
      io.out("Restarting localDot and checking its computers. Saved apps and files are kept.");
      const stopped = await runtime.down(input, io);
      if (stopped !== 0) return stopped;
      options.signal.throwIfAborted();
      const started = await runtime.up(input, io);
      if (started !== 0) return started;
    }
    const context = await runtime.context({
      home: localdotHome(options.env),
      env: options.env,
      signal: options.signal,
    });
    options.signal.throwIfAborted();
    if (command.kind === "chat") {
      if (!runtime.chat) {
        io.err("Terminal chat is unavailable in this build.");
        return 1;
      }
      return await runtime.chat(context, io);
    }
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
    if (command.kind === "browser")
      return await runtime.browser(
        {
          ...context,
          operation: command.operation,
          ...(command.cellId ? { cellId: command.cellId } : {}),
        },
        io,
      );
    if (command.kind === "recover")
      return await runtime.recover(
        {
          ...context,
          cellId: command.cellId,
          ...(command.confirmNativeExit ? { confirmNativeExit: true } : {}),
        },
        io,
      );
    return await runtime.doctor(context, io);
  } catch (error) {
    if (
      (error instanceof DotsCommandError || error instanceof CommandError) &&
      !options.signal.aborted
    ) {
      io.err(error.message);
      return 1;
    }
    io.err(
      options.signal.aborted
        ? "Command interrupted."
        : "Command could not complete. Check the local daemon configuration.",
    );
    return options.signal.aborted ? 130 : 1;
  }
}
