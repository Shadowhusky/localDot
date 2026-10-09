import { spawn } from "node:child_process";
import { type ServiceLocation, serviceLocation } from "./service-definition.ts";

export type ServiceOperation = "bootstrap" | "bootout" | "print" | "kickstart";
export type ServiceObservation = "manageruid" | "managername" | "list";
export type ServiceCommandResult = Readonly<{ code: number; stdout: string; stderr: string }>;
const failure = () => new Error("The localDot service command did not complete reliably.");

/** Low-level transport, not authority to mutate a job. The lifecycle owner must verify the
 * durable plist and loaded job identity before mutation. No domain-wide bootout, force-restart,
 * shell or arbitrary arguments are exposed. An exit code is not proof of readiness/containment.
 */
export function runServiceCommand(
  location: ServiceLocation,
  operation: ServiceOperation,
  signal: AbortSignal,
): Promise<ServiceCommandResult> {
  signal.throwIfAborted();
  const supplied = { ...location };
  if (supplied.role !== "keyd" && supplied.role !== "daemon") throw failure();
  const generated = serviceLocation(
    supplied.state,
    supplied.home,
    supplied.uid,
    supplied.ownerId,
    supplied.configuration,
    supplied.manager,
  )[supplied.role];
  for (const field of ["manager", "label", "domain", "target", "file"] as const)
    if (supplied[field] !== generated[field]) throw failure();
  if (generated.manager === "systemd") return systemdCommand(generated, operation, signal);
  let args: string[];
  switch (operation) {
    case "bootstrap":
      args = ["bootstrap", generated.domain, generated.file];
      break;
    case "kickstart":
      args = ["kickstart", "-p", generated.target];
      break;
    case "bootout":
    case "print":
      args = [operation, generated.target];
      break;
    default:
      throw failure();
  }
  return launchctl(args, signal);
}

/** The same operations for a systemd user unit. link puts the unit in the user manager's search
 * path, as bootstrap loads a plist; bootout stops it and takes the link away; kickstart starts it
 * and reports MainPID the way kickstart -p reports its PID. */
async function systemdCommand(
  location: ServiceLocation,
  operation: ServiceOperation,
  signal: AbortSignal,
): Promise<ServiceCommandResult> {
  const unit = location.target;
  switch (operation) {
    case "bootstrap":
      return systemctl(location.uid, ["link", location.file], signal);
    case "kickstart": {
      const started = await systemctl(location.uid, ["start", unit], signal);
      if (started.code !== 0) return started;
      return systemctl(location.uid, ["show", "--property=MainPID", "--value", unit], signal);
    }
    case "bootout": {
      const stopped = await systemctl(location.uid, ["stop", unit], signal);
      if (stopped.code !== 0) return stopped;
      return systemctl(location.uid, ["disable", unit], signal);
    }
    case "print":
      return systemctl(location.uid, ["show", "--property=LoadState", unit], signal);
    default:
      throw failure();
  }
}

/** Reads one owned unit's state; systemd prints the properties in an order of its own. */
export function runUnitObservation(
  location: ServiceLocation,
  signal: AbortSignal,
): Promise<ServiceCommandResult> {
  signal.throwIfAborted();
  if (location.manager !== "systemd" || !SERVICE_UNIT.test(location.target)) throw failure();
  return systemctl(
    location.uid,
    ["show", "--property=LoadState,ActiveState,MainPID", location.target],
    signal,
  );
}

const SERVICE_UNIT = /^dev\.localdot\.[a-f0-9]{64}\.[a-f0-9]{32}\.(?:keyd|daemon)\.service$/;
const LOGIN_UNIT = /^dev\.localdot\.[a-f0-9]{64}\.[a-f0-9]{32}\.login\.service$/;

/** Turns this installation's login unit on or off in the user manager; reload picks up a changed
 * file. The unit is always derived by loginServiceLocation. */
export function runLoginUnit(
  operation: "enable" | "disable" | "daemon-reload",
  unit: string,
  uid: number,
  signal: AbortSignal,
): Promise<ServiceCommandResult> {
  signal.throwIfAborted();
  if (!LOGIN_UNIT.test(unit) || !["enable", "disable", "daemon-reload"].includes(operation))
    throw failure();
  return systemctl(uid, operation === "daemon-reload" ? [operation] : [operation, unit], signal);
}

// The user manager answers on the runtime directory systemd makes for this UID, never one the
// environment names.
function systemctl(uid: number, args: string[], signal: AbortSignal) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || uid !== process.getuid?.()) throw failure();
  return run(
    "/usr/bin/systemctl",
    ["--user", ...args],
    { PATH: "/usr/bin:/bin", LC_ALL: "C", XDG_RUNTIME_DIR: `/run/user/${uid}` },
    signal,
  );
}

/** These legacy commands have documented output. No arbitrary command, label or print parser. */
export function runServiceObservation(
  operation: ServiceObservation,
  signal: AbortSignal,
): Promise<ServiceCommandResult> {
  signal.throwIfAborted();
  if (!["manageruid", "managername", "list"].includes(operation)) throw failure();
  return launchctl([operation], signal);
}

/** Unloads this installation's login job from the current GUI session. The target is always
 * derived by loginServiceLocation; "not loaded" counts as done (launchctl exits 3 or 113).
 */
export function runLoginAgentBootout(
  target: string,
  signal: AbortSignal,
): Promise<ServiceCommandResult> {
  signal.throwIfAborted();
  if (!/^gui\/[1-9][0-9]*\/dev\.localdot\.[a-f0-9]{64}\.[a-f0-9]{32}\.login$/.test(target))
    throw failure();
  return launchctl(["bootout", target], signal);
}

function launchctl(args: string[], signal: AbortSignal): Promise<ServiceCommandResult> {
  return run("/bin/launchctl", args, { PATH: "/usr/bin:/bin", LC_ALL: "C" }, signal);
}

function run(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<ServiceCommandResult> {
  return new Promise((resolve, reject) => {
    const create = () =>
      spawn(program, args, {
        cwd: "/",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    let child: ReturnType<typeof create>;
    try {
      child = create();
    } catch {
      reject(failure());
      return;
    }
    let failed = false,
      bytes = 0;
    const out: Buffer[] = [],
      err: Buffer[] = [];
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 30_000);
    const collect = (chunk: Buffer, target: Buffer[]) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > 128 * 1024) {
        stop();
        return;
      }
      target.push(chunk);
    };
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, out));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, err));
    child.stdout.once("error", stop);
    child.stderr.once("error", stop);
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code, terminationSignal) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (
        failed ||
        terminationSignal ||
        !Number.isInteger(code) ||
        code === null ||
        code < 0 ||
        code > 255
      ) {
        reject(failure());
        return;
      }
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        resolve(
          Object.freeze({
            code,
            stdout: decoder.decode(Buffer.concat(out)),
            stderr: decoder.decode(Buffer.concat(err)),
          }),
        );
      } catch {
        reject(failure());
      }
    });
    if (signal.aborted) stop();
  });
}
