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
  )[supplied.role];
  for (const field of ["label", "domain", "target", "plist"] as const)
    if (supplied[field] !== generated[field]) throw failure();
  let args: string[];
  switch (operation) {
    case "bootstrap":
      args = ["bootstrap", generated.domain, generated.plist];
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
  return new Promise((resolve, reject) => {
    const create = () =>
      spawn("/bin/launchctl", args, {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
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
