import {
  runServiceObservation,
  runUnitObservation,
  type ServiceCommandResult,
} from "./service-command.ts";
import { type ServiceLocation, serviceLocation } from "./service-definition.ts";

const failure = () =>
  new Error("The localDot service manager context or service state could not be confirmed.");
function output(result: ServiceCommandResult) {
  if (result.code !== 0 || result.stderr !== "" || Buffer.byteLength(result.stdout) > 128 * 1024)
    throw failure();
  return result.stdout;
}

/** launchctl(1) documents the legacy list's three columns. A nonzero command result, malformed
 * list or wrong bootstrap context is unknown, never absence. Foreign rows are inspected only.
 */
export function parseServiceList(result: ServiceCommandResult): ReadonlyMap<string, number | null> {
  const text = output(result);
  if (!text.endsWith("\n")) throw failure();
  const [header, ...lines] = text.slice(0, -1).split("\n");
  if (!/^PID[\t ]+Status[\t ]+Label$/.test(header ?? "")) throw failure();
  const jobs = new Map<string, number | null>();
  for (const line of lines) {
    const match = /^(-|[1-9][0-9]*)[\t ]+(-?(?:0|[1-9][0-9]*))[\t ]+(.+)$/.exec(line);
    if (!match) throw failure();
    const [, rawPid, rawStatus, label] = match;
    if (
      !label ||
      label.length > 1024 ||
      [...label].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      jobs.has(label)
    )
      throw failure();
    const pid = rawPid === "-" ? null : Number(rawPid),
      status = Number(rawStatus);
    if (
      (pid !== null && (!Number.isInteger(pid) || pid > 0x7fff_ffff)) ||
      !Number.isInteger(status) ||
      status < -0x8000_0000 ||
      status > 0x7fff_ffff
    )
      throw failure();
    jobs.set(label, pid);
  }
  return jobs;
}

/** list reports the caller's bootstrap context. Verify Aqua and the current user's UID before
 * and after reading it; never mistake a system, SSH or another user's domain for gui/<uid>.
 */
export async function observeServiceJob(
  input: ServiceLocation,
  signal: AbortSignal,
): Promise<{ pid: number | null } | null> {
  const location = { ...input };
  if (
    (location.role !== "keyd" && location.role !== "daemon") ||
    location.uid !== process.getuid?.()
  )
    throw failure();
  const expected = serviceLocation(
    location.state,
    location.home,
    location.uid,
    location.ownerId,
    location.configuration,
    location.manager,
  )[location.role];
  if (
    Object.keys(expected).some(
      (key) => expected[key as keyof typeof expected] !== location[key as keyof typeof location],
    )
  )
    throw failure();
  if (expected.manager === "systemd")
    return parseUnitState(await runUnitObservation(expected, signal));
  const context = async () => {
    const uid = output(await runServiceObservation("manageruid", signal));
    const name = output(await runServiceObservation("managername", signal));
    if (uid !== `${location.uid}\n` || name !== "Aqua\n") throw failure();
  };
  await context();
  const jobs = parseServiceList(await runServiceObservation("list", signal));
  await context();
  signal.throwIfAborted();
  return jobs.has(location.label) ? { pid: jobs.get(location.label) ?? null } : null;
}

/** A unit the user manager does not know is absent; a loaded one is present, with its main PID
 * while it runs. Any other load state, or output that is not exactly these properties, is unknown.
 */
export function parseUnitState(result: ServiceCommandResult): { pid: number | null } | null {
  const text = output(result);
  if (!text.endsWith("\n")) throw failure();
  const state = new Map<string, string>();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^(LoadState|ActiveState|MainPID)=([a-z-]*|0|[1-9][0-9]*)$/.exec(line);
    if (!match || state.has(match[1] as string)) throw failure();
    state.set(match[1] as string, match[2] as string);
  }
  const load = state.get("LoadState"),
    pid = Number(state.get("MainPID"));
  if (state.size !== 3 || !Number.isSafeInteger(pid) || pid < 0 || pid > 0x7fff_ffff)
    throw failure();
  if (load === "not-found") {
    if (pid !== 0) throw failure();
    return null;
  }
  if (load !== "loaded") throw failure();
  return { pid: pid === 0 ? null : pid };
}
