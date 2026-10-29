import { join, resolve } from "node:path";
import { computers } from "./computer.ts";
import { type DotServices, ServicesError } from "./dots/services.ts";
import { type AppState, fail, type LocalDot, type LockName } from "./local-dot.ts";
import type { ConsoleIO } from "./runtime.ts";

// How the services' own processes look: node running the daemon, and keyd.
const OWN_PROCESS: Record<LockName, RegExp> = {
  daemon: /(?:^|[\s/])(?:src\/main\.ts|daemon\.mjs)(?:\s|$)/,
  keyd: /(?:^|\/)keyd(?:\s|$)/,
};
const STOP_MS = 30_000;
const KILL_MS = 20_000;
const START_MS = 120_000;
const KEYD_MS = 30_000;
const NOTICE_MS = 15_000;

async function until(l: LocalDot, check: () => boolean | Promise<boolean>, ms: number) {
  const deadline = l.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (l.now() >= deadline) return false;
    await l.sleep(500);
  }
}

function refuseDuringInstall(l: LocalDot) {
  const pid = l.installer();
  if (pid)
    fail(
      `localDot is being installed or updated right now (installer process ${pid}). Wait for it to finish, then run localdot status.`,
    );
}

function failWithLog(l: LocalDot, log: LockName, problem: string): never {
  const lines = l.logTail(log);
  return fail(
    [
      problem,
      ...(lines.length
        ? [`The end of ${join(l.home, "logs", `${log}.log`)}:`, ...lines.map((line) => `  ${line}`)]
        : []),
      `Fix what it reports, then run localdot restart${l.dotFlag}. localdot doctor${l.dotFlag} checks Docker, the key service and the computers.`,
    ].join("\n"),
  );
}

// This dot's own services, and only when they run this data folder.
async function ownServices(l: LocalDot, state: AppState): Promise<DotServices> {
  const services = l.services;
  const names = services?.names(l.dot);
  const home = services && (await services.exists(l.dot)) ? await services.home(l.dot) : undefined;
  if (services && names && home !== undefined) {
    if (resolve(home) === resolve(l.home)) return services;
    fail(
      `${names.daemon} runs the localDot in ${home}, not ${l.home}, so it was left alone. Choose a dot with --dot <name>, or set LOCALDOT_HOME to its folder.`,
    );
  }
  const holder = l.lockHolder("daemon");
  const elsewhere =
    state === "stopped"
      ? ""
      : holder
        ? `, so the ${l.name} running as process ${holder} was started some other way, such as from a terminal: restart it there`
        : `, and another program is using port ${l.port}`;
  return fail(
    `${l.name}'s services${names ? ` (${names.keyd} and ${names.daemon})` : ""} aren't set up on this computer${elsewhere}. To set the services up again, rerun the localDot installer.`,
  );
}

// Before a running app stops: never in the middle of an update, and say what a running task does.
async function beforeStopping(l: LocalDot, io: ConsoleIO) {
  let api: ReturnType<LocalDot["api"]>;
  try {
    api = l.api();
  } catch {
    return;
  }
  const update = await api<{ phase?: unknown }>("GET", "/api/app-update").catch(() => undefined);
  if (update?.phase === "installing")
    fail(
      `An update is being installed. ${l.name} restarts by itself when it's done; check with localdot status${l.dotFlag} in a minute.`,
    );
  for (const c of await computers(api).catch(() => []))
    if (c.task)
      io.out(
        `A task is running on computer ${c.id}. It stops now; its conversation and history are kept, so you can send a message to carry on.`,
      );
}

// Waits for the process holding a lock to exit. One that outlives its service is this dot's own
// and is stopped by its pid; a lock whose pid now names another program is left from an earlier run.
async function ended(l: LocalDot, io: ConsoleIO, lock: LockName) {
  const what = lock === "daemon" ? l.name : `${l.name}'s key service`;
  const holder = l.lockHolder(lock);
  if (!holder) return;
  const command = await l.command(holder);
  if (!command || !OWN_PROCESS[lock].test(command)) {
    if (l.lockHolder(lock) !== holder) return;
    if (!command)
      fail(
        `Process ${holder} holds ${what}'s lock in ${l.home}. If it isn't localDot, delete the lock file, then run localdot restart${l.dotFlag}.`,
      );
    l.removeLock(lock);
    io.out(`Cleared a lock left by an earlier run (process ${holder} is another program now).`);
    return;
  }
  if (await until(l, () => !l.lockHolder(lock), STOP_MS)) return;
  io.out(`${what} (process ${holder}) is still running; stopping it.`);
  l.kill(holder, "SIGTERM");
  if (await until(l, () => l.lockHolder(lock) !== holder, KILL_MS)) return;
  l.kill(holder, "SIGKILL");
  if (await until(l, () => l.lockHolder(lock) !== holder, 5000)) return;
  fail(
    `${what} (process ${holder}) didn't stop. Stop it with kill -9 ${holder}, then run localdot restart${l.dotFlag}.`,
  );
}

async function portFree(l: LocalDot) {
  // The port closes with the process, a moment after its lock goes.
  if (await until(l, async () => (await l.app()) === "stopped", 5000)) return;
  const owner = await l.listener();
  fail(
    `Port ${l.port} is in use by ${owner ? `${owner.command} (process ${owner.pid})` : "another program"}, so ${l.name} can't start. Quit that program (or install localDot with another --port), then run localdot restart${l.dotFlag}.`,
  );
}

// Starts the services, keeping the start-at-login choice: launchd starts only enabled agents.
async function launch(l: LocalDot, services: DotServices, only?: "keyd") {
  const login = await services.login(l.dot).catch(() => true);
  try {
    await services.start(l.dot, only);
  } catch (error) {
    if (error instanceof ServicesError) fail(error.message);
    throw error;
  } finally {
    if (!login) await services.setLogin(l.dot, false).catch(() => {});
  }
}

async function answered(l: LocalDot, io: ConsoleIO) {
  const started = l.now();
  let notice = started + NOTICE_MS;
  while (l.now() - started < START_MS) {
    if ((await l.app()) === "running") return;
    if (l.now() >= notice) {
      io.out(
        `Waiting for ${l.name} to answer (${Math.round((l.now() - started) / 1000)} seconds)…`,
      );
      notice += NOTICE_MS;
    }
    await l.sleep(1000);
  }
  failWithLog(l, "daemon", `${l.name} didn't answer within ${START_MS / 1000} seconds.`);
}

// The app answers: bring up what it needs for computers, then hand out a sign-in link.
async function ready(l: LocalDot, services: DotServices | undefined, io: ConsoleIO, link = true) {
  let keyd = await l.keyd();
  if (keyd === "down") {
    io.out("Starting the key service…");
    if (services) await launch(l, services, "keyd");
    const deadline = l.now() + KEYD_MS;
    while (keyd === "down" && l.now() < deadline) {
      await l.sleep(1000);
      keyd = await l.keyd();
    }
    if (keyd === "down")
      failWithLog(
        l,
        "keyd",
        `${l.name} is running, but its key service isn't answering, so computers can't start.`,
      );
  }
  if (keyd === "locked")
    io.out(`Your saved keys are locked. Unlock them with: localdot unlock${l.dotFlag}`);
  if (!(await l.docker()))
    io.out(
      (await l.startDocker())
        ? "Docker isn't running, so Docker Desktop is starting. Computers can start once it's up."
        : "Docker isn't running, so computers can't start. Start Docker (on Linux: sudo systemctl start docker); localDot notices by itself.",
    );
  io.out(`${l.name} is ready.`);
  return link ? l.signIn(io) : 0;
}

async function cycle(
  l: LocalDot,
  io: ConsoleIO,
  services: DotServices,
  before: AppState,
): Promise<number> {
  // keyd keeps running unless it is broken: restarting it locks a passphrase vault and
  // revokes the computers' key stand-ins.
  const keydUp = (await l.keyd()) !== "down";
  io.out(
    before === "running"
      ? `Restarting ${l.name}. Computers keep running and keep their data.`
      : before === "stopped"
        ? `${l.name} isn't running; starting it.`
        : `${l.name} isn't answering on port ${l.port}; restarting it.`,
  );
  await services.stop(l.dot, keydUp ? "daemon" : undefined);
  await ended(l, io, "daemon");
  if (!keydUp) await ended(l, io, "keyd");
  await portFree(l);
  io.out(`Starting ${l.name}…`);
  await launch(l, services);
  await answered(l, io);
  return ready(l, services, io);
}

export async function restartLocalDot(l: LocalDot, io: ConsoleIO): Promise<number> {
  refuseDuringInstall(l);
  const before = await l.app();
  if (!l.managed) {
    const services = await ownServices(l, before);
    if (before === "running") await beforeStopping(l, io);
    return cycle(l, io, services, before);
  }
  if (before === "running") await beforeStopping(l, io);
  io.out("Restarting localDot. Its computers shut down with it and keep their data.");
  const down = await l.managedDown(io);
  if (down !== 0) return down;
  l.signal.throwIfAborted();
  return l.managedUp(io);
}

export async function upLocalDot(
  l: LocalDot,
  io: ConsoleIO,
  options: { atLogin?: boolean; fromLogin?: boolean } = {},
): Promise<number> {
  refuseDuringInstall(l);
  const state = await l.app();
  // Already up, perhaps run from a terminal: nothing to start.
  if (state === "running" && !options.atLogin)
    return ready(l, await ownServices(l, state).catch(() => undefined), io, !options.fromLogin);
  const services = await ownServices(l, state);
  if (options.atLogin) await services.setLogin(l.dot, true);
  if (state === "not-answering") return cycle(l, io, services, state);
  if (state === "stopped") {
    const holder = l.lockHolder("daemon");
    const command = holder ? await l.command(holder) : undefined;
    // A daemon that is still starting holds its lock before it listens.
    if (!command || !OWN_PROCESS.daemon.test(command)) {
      await ended(l, io, "daemon");
      await portFree(l);
      io.out(`Starting ${l.name}…`);
      await launch(l, services);
    }
    await answered(l, io);
  }
  return ready(l, services, io, !options.fromLogin);
}

export async function downLocalDot(l: LocalDot, io: ConsoleIO): Promise<number> {
  refuseDuringInstall(l);
  const state = await l.app();
  const services = await ownServices(l, state);
  if (state === "running") await beforeStopping(l, io);
  io.out(`Stopping ${l.name} and its computers…`);
  await services.stop(l.dot);
  await ended(l, io, "daemon");
  await ended(l, io, "keyd");
  if (!(await l.stopComputers()))
    fail(
      `${l.name} stopped, but its computers couldn't be confirmed stopped. Check Docker, then run localdot down${l.dotFlag} again. Their data is kept.`,
    );
  io.out(`${l.name} is down. Computer data has been preserved.`);
  return 0;
}

export async function startAtLoginLocalDot(
  l: LocalDot,
  operation: "on" | "off" | "status",
  io: ConsoleIO,
): Promise<number> {
  const services = await ownServices(l, await l.app());
  if (operation !== "status") await services.setLogin(l.dot, operation === "on");
  io.out((await services.login(l.dot)) ? "on" : "off");
  return 0;
}
