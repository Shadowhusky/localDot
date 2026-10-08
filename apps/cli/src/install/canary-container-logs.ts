import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual as equal } from "node:util";
import {
  CanaryOperation,
  canaryResourceLabels,
  canaryResourceName,
} from "../../../../packages/protocol/src/canary-operation.ts";
import { dockerSocketPath } from "../../../daemon/src/cells/docker.ts";
import { canaryCleanupClient } from "./canary-cleanup-client.ts";
import { canaryDockerExchange, canaryDockerStreams } from "./canary-docker-exchange.ts";

const ROLES = ["desktop", "gate"] as const;
type Role = (typeof ROLES)[number];
const failure = () => new Error("The complete diagnostic container logs could not be verified.");
const recovery = () => new Error("Diagnostic containers require recovery before another run.");
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const decode = (v: Buffer): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(v));
const fullId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const LOG_COMMAND =
  'set -eu; printf "%s\\n" "$1" > /proc/1/fd/1; printf "%s\\n" "$2" > /proc/1/fd/2';
export type CanaryContainerLogs = Record<Role, { stdout: Buffer; stderr: Buffer }>;

/** Wrap the desktop exercise inside the operation/helper lifetime scopes. Work
 * must settle only after its remote effects drain. Both streams get independent
 * start/end controls, then BOTH containers stop before full log collection.
 * Returned bytes are private evidence for the final secret scan, never UI data.
 * This neither deletes resources nor proves absence of a secret by itself. */
export async function withCanaryContainerLogs<T>(
  socketInput: string,
  input: CanaryOperation,
  signal: AbortSignal,
  work: (active: AbortSignal) => Promise<T>,
): Promise<{ value: T; logs: CanaryContainerLogs }> {
  const operation = CanaryOperation.parse(input),
    socket = dockerSocketPath({ DOCKER_HOST: `unix://${socketInput}` });
  if (operation.phase !== "active" || !ROLES.every((role) => fullId(operation.resources[role])))
    throw failure();
  const ids = { desktop: operation.resources.desktop ?? "", gate: operation.resources.gate ?? "" };
  const cleanup = canaryCleanupClient(socket);
  const active = new AbortController(),
    abort = () => active.abort(failure());
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 360_000),
    exchange = canaryDockerExchange(socket, active.signal);
  const markers = Object.fromEntries(
    ROLES.map((role) => [
      role,
      {
        start: {
          stdout: `log-${role}-stdout-start-${randomBytes(16).toString("hex")}`,
          stderr: `log-${role}-stderr-start-${randomBytes(16).toString("hex")}`,
        },
        end: {
          stdout: `log-${role}-stdout-end-${randomBytes(16).toString("hex")}`,
          stderr: `log-${role}-stderr-end-${randomBytes(16).toString("hex")}`,
        },
      },
    ]),
  ) as Record<Role, Record<"start" | "end", Record<"stdout" | "stderr", string>>>;
  let effects = false,
    retirementAttempted = false,
    retired = false;
  const execIds = new Set<string>();
  async function engine(s: AbortSignal) {
    s.throwIfAborted();
    const found = await cleanup.engine(s);
    if (
      found.id !== operation.engineId ||
      found.operatingSystem !== "linux" ||
      found.architecture !== "arm64"
    )
      throw failure();
  }
  function owned(role: Role, raw: unknown) {
    const config = object(raw) && object(raw.Config) ? raw.Config : undefined,
      labels = config && object(config.Labels) ? config.Labels : undefined,
      state = object(raw) && object(raw.State) ? raw.State : undefined;
    if (
      !object(raw) ||
      raw.Id !== ids[role] ||
      raw.Name !== `/${canaryResourceName(operation.runId, role)}` ||
      raw.Image !== operation.images[role].id ||
      config?.Image !== operation.images[role].ref ||
      !labels ||
      Object.entries(canaryResourceLabels(operation, role)).some(
        ([key, value]) => labels[key] !== value,
      ) ||
      !state ||
      ["Running", "Paused", "Restarting", "Dead"].some((key) => typeof state[key] !== "boolean")
    )
      throw failure();
    return state;
  }
  async function state(role: Role, running: boolean, s: AbortSignal) {
    await engine(s);
    const value = owned(role, await cleanup.inspect(role, ids[role], s));
    if (value.Running !== running || value.Paused || value.Restarting || value.Dead)
      throw failure();
    s.throwIfAborted();
  }
  async function retire() {
    retirementAttempted = true;
    retired = false;
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(recovery()), 30_000);
    let failed = false;
    try {
      for (const role of ROLES) {
        try {
          await engine(controller.signal);
          let raw = await cleanup.inspect(role, ids[role], controller.signal);
          if (raw !== null) {
            const value = owned(role, raw);
            if (value.Running || value.Paused || value.Restarting) {
              await engine(controller.signal);
              try {
                await cleanup.stop(ids[role], controller.signal);
              } catch {
                controller.signal.throwIfAborted();
              }
            }
            raw = await cleanup.inspect(role, ids[role], controller.signal);
          }
          if (raw === null) {
            if (
              (await cleanup.inspect(
                role,
                canaryResourceName(operation.runId, role),
                controller.signal,
              )) !== null
            )
              throw recovery();
          } else {
            const value = owned(role, raw);
            if (value.Running || value.Paused || value.Restarting) throw recovery();
          }
        } catch {
          failed = true;
        }
      }
      await engine(controller.signal);
      if (failed) throw recovery();
      controller.signal.throwIfAborted();
      retired = true;
    } catch {
      throw recovery();
    } finally {
      clearTimeout(timer);
    }
  }
  async function writeMarkers(role: Role, phase: "start" | "end") {
    await state(role, true, active.signal);
    const args = [
      "-c",
      LOG_COMMAND,
      "localdot-log-control",
      markers[role][phase].stdout,
      markers[role][phase].stderr,
    ];
    effects = true;
    const created = decode(
      await exchange(
        "POST",
        `/containers/${ids[role]}/exec`,
        {
          AttachStdin: false,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          Privileged: true,
          User: "root",
          WorkingDir: "/",
          Env: ["PATH=/usr/bin:/bin", "LANG=C"],
          Cmd: ["/bin/sh", ...args],
        },
        201,
        "json",
      ),
    );
    if (!object(created) || !fullId(created.Id) || execIds.has(created.Id)) throw failure();
    const id = created.Id;
    execIds.add(id);
    async function inspect() {
      const value = decode(await exchange("GET", `/exec/${id}/json`, undefined, 200, "json"));
      if (
        !object(value) ||
        value.ID !== id ||
        value.ContainerID !== ids[role] ||
        !object(value.ProcessConfig) ||
        value.ProcessConfig.entrypoint !== "/bin/sh" ||
        !equal(value.ProcessConfig.arguments, args) ||
        value.ProcessConfig.user !== "root" ||
        value.ProcessConfig.privileged !== true ||
        value.ProcessConfig.tty !== false ||
        typeof value.Running !== "boolean" ||
        !Number.isInteger(value.ExitCode)
      )
        throw failure();
      return value;
    }
    if ((await inspect()).Running) throw failure();
    await state(role, true, active.signal);
    const output = canaryDockerStreams(
      await exchange(
        "POST",
        `/exec/${id}/start`,
        { Detach: false, Tty: false },
        200,
        "stream",
        4096,
      ),
      0,
      0,
    );
    if (output.stdout.length || output.stderr.length) throw failure();
    const until = Date.now() + 5000;
    for (;;) {
      const value = await inspect();
      if (!value.Running) {
        if (value.ExitCode !== 0) throw failure();
        break;
      }
      if (Date.now() >= until) throw failure();
      await delay(50, undefined, { signal: active.signal });
    }
    await state(role, true, active.signal);
  }
  function controlled(role: Role, bytes: { stdout: Buffer; stderr: Buffer }) {
    return (["stdout", "stderr"] as const).every((stream) => {
      const data = bytes[stream],
        start = markers[role].start[stream],
        end = markers[role].end[stream];
      const first = data.indexOf(start),
        last = data.indexOf(end);
      return (
        first >= 0 &&
        last > first &&
        data.lastIndexOf(start) === first &&
        data.lastIndexOf(end) === last
      );
    });
  }
  try {
    for (const role of ROLES) await state(role, true, active.signal);
    for (const role of ROLES) await writeMarkers(role, "start");
    active.signal.throwIfAborted();
    const value = await work(active.signal);
    active.signal.throwIfAborted();
    for (const role of ROLES) await writeMarkers(role, "end");
    await retire();
    const logs = {} as CanaryContainerLogs;
    for (const role of ROLES) {
      const until = Date.now() + 5000;
      for (;;) {
        await state(role, false, active.signal);
        const query = new URLSearchParams({
          stdout: "true",
          stderr: "true",
          timestamps: "false",
          follow: "false",
          tail: "all",
        });
        const bytes = await exchange(
          "GET",
          `/containers/${ids[role]}/logs?${query}`,
          undefined,
          200,
          "stream",
          16 * 1024 * 1024,
        );
        const streams = canaryDockerStreams(bytes, 8 * 1024 * 1024, 8 * 1024 * 1024);
        await state(role, false, active.signal);
        if (controlled(role, streams)) {
          logs[role] = streams;
          break;
        }
        if (Date.now() >= until) throw failure();
        await delay(100, undefined, { signal: active.signal });
      }
    }
    for (const role of ROLES) await state(role, false, active.signal);
    return { value, logs };
  } catch {
    if (effects && (!retirementAttempted || retired)) await retire();
    if (retirementAttempted && !retired) throw recovery();
    throw failure();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
