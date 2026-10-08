import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual as equal } from "node:util";
import {
  CanaryOperation,
  canaryResourceLabels,
  canaryResourceName,
} from "../../../../packages/protocol/src/canary-operation.ts";
import { CanaryReady } from "../../../../packages/protocol/src/canary-process.ts";
import { dockerSocketPath } from "../../../daemon/src/cells/docker.ts";
import { tar } from "../../../daemon/src/cells/tar.ts";
import {
  CANARY_FORMS,
  type CanaryControls,
  canaryScanVerdict,
} from "../../../daemon/src/diagnostics/canary-verdict.ts";
import type { CanaryAssets } from "./canary-assets.ts";
import { canaryCleanupClient } from "./canary-cleanup-client.ts";
import { canaryDockerExchange, canaryDockerStreams } from "./canary-docker-exchange.ts";

const failure = () => new Error("The diagnostic desktop scan could not be verified.");
const retirementFailure = () =>
  new Error("The diagnostic desktop requires recovery before another scan.");
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const fullId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const decode = (bytes: Buffer): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
function path(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value !== "/" &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= 4096 &&
    posix.normalize(value) === value
  );
}
function kernelPath(value: string) {
  return ["/proc", "/sys"].some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

/** Caller holds the install mutex and lifetime lease, inside withCanaryProcess.
 * The operation must be the completed topology's captured journal and assets
 * must come from readCanaryAssets. This proves one desktop scan only. The caller
 * must still drain the helper/containers and inspect final logs/artifacts.
 *
 * No arbitrary commands, URLs, container IDs or host paths are accepted. On any
 * uncertain effect, requests drain before fresh full-ID desktop retirement.
 * If retirement cannot be proved, durable outer recovery must retain the run.
 */
export async function runCanaryDesktopScan(
  socketInput: string,
  input: CanaryOperation,
  inputReady: CanaryReady,
  inputAssets: CanaryAssets,
  signal: AbortSignal,
) {
  const operation = CanaryOperation.parse(input),
    ready = CanaryReady.parse(inputReady);
  const socketPath = dockerSocketPath({ DOCKER_HOST: `unix://${socketInput}` });
  if (
    operation.phase !== "active" ||
    ready.runId !== operation.runId ||
    ready.cellId !== operation.cellId ||
    !operation.resources.home ||
    ![
      operation.resources.desktop,
      operation.resources.gate,
      operation.resources.internal,
      operation.resources.egress,
    ].every(fullId)
  )
    throw failure();
  const desktop = operation.resources.desktop ?? "";
  if (!fullId(desktop)) throw failure();
  const assets = {
    scanner: Buffer.from(inputAssets.scanner),
    worker: Buffer.from(inputAssets.worker),
  };
  if (Object.values(assets).some((bytes) => !bytes.length || bytes.length > 128 * 1024))
    throw failure();
  const cleanup = canaryCleanupClient(socketPath),
    name = canaryResourceName(operation.runId, "desktop");
  const prefix = `localdot-canary-${operation.runId}`;
  const scripts = { scanner: `/tmp/${prefix}-scan.py`, worker: `/tmp/${prefix}-worker.py` };
  const marker = `control-${randomBytes(16).toString("hex")}`,
    clipboard = `clipboard-${randomBytes(16).toString("hex")}`;
  const controlDirectory = `/tmp/localdot-canary-${marker}`;
  const controls: CanaryControls = {
    canary: ready.syntheticSecret,
    marker,
    clipboard,
    surrogate: ready.surrogate,
    files: CANARY_FORMS.map((form, index) => ({
      form,
      path: `${controlDirectory}/${index}-${form}`,
    })),
  };
  let effects = false;
  const deadline = new AbortController(),
    abort = () => deadline.abort(failure());
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 240_000);

  async function engine(s: AbortSignal) {
    s.throwIfAborted();
    const current = await cleanup.engine(s);
    if (
      current.id !== operation.engineId ||
      current.operatingSystem !== "linux" ||
      current.architecture !== "arm64"
    )
      throw failure();
  }
  function owned(value: unknown) {
    const config = object(value) && object(value.Config) ? value.Config : undefined;
    const labels = config && object(config.Labels) ? config.Labels : undefined;
    const state = object(value) && object(value.State) ? value.State : undefined;
    if (
      !object(value) ||
      value.Id !== desktop ||
      value.Name !== `/${name}` ||
      value.Image !== operation.images.desktop.id ||
      config?.Image !== operation.images.desktop.ref ||
      !labels ||
      Object.entries(canaryResourceLabels(operation, "desktop")).some(
        ([key, expected]) => labels[key] !== expected,
      ) ||
      !state ||
      ["Running", "Paused", "Restarting", "Dead"].some((key) => typeof state[key] !== "boolean")
    )
      throw failure();
    return state;
  }
  async function running(s: AbortSignal) {
    await engine(s);
    const state = owned(await cleanup.inspect("desktop", desktop, s));
    if (
      state.Running !== true ||
      state.Paused !== false ||
      state.Restarting !== false ||
      state.Dead !== false
    )
      throw failure();
    s.throwIfAborted();
  }
  async function retire() {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(retirementFailure()), 30_000);
    try {
      await engine(controller.signal);
      let value = await cleanup.inspect("desktop", desktop, controller.signal);
      if (value === null) {
        if ((await cleanup.inspect("desktop", name, controller.signal)) !== null)
          throw retirementFailure();
      } else {
        const state = owned(value);
        if (state.Running || state.Paused || state.Restarting) {
          await engine(controller.signal);
          try {
            await cleanup.stop(desktop, controller.signal);
          } catch {
            controller.signal.throwIfAborted();
          }
        }
        value = await cleanup.inspect("desktop", desktop, controller.signal);
        if (value === null) {
          if ((await cleanup.inspect("desktop", name, controller.signal)) !== null)
            throw retirementFailure();
        } else {
          const after = owned(value);
          if (after.Running || after.Paused || after.Restarting) throw retirementFailure();
        }
      }
      await engine(controller.signal);
      controller.signal.throwIfAborted();
    } catch {
      throw retirementFailure();
    } finally {
      clearTimeout(timer);
    }
  }

  const exchange = canaryDockerExchange(socketPath, deadline.signal);
  const execIds = new Set<string>();
  async function execute(args: string[], scan = false) {
    await running(deadline.signal);
    effects = true;
    const command = [
      "/usr/bin/python3",
      "-I",
      "-B",
      scan ? scripts.scanner : scripts.worker,
      ...args,
    ];
    const created = decode(
      await exchange(
        "POST",
        `/containers/${desktop}/exec`,
        {
          AttachStdin: false,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          Privileged: scan,
          User: scan ? "root" : "abc",
          WorkingDir: "/",
          Env: ["PATH=/usr/bin:/bin", "LANG=C.UTF-8", "DISPLAY=:1"],
          Cmd: command,
        },
        201,
        "json",
      ),
    );
    if (!object(created) || !fullId(created.Id) || execIds.has(created.Id)) throw failure();
    const execId = created.Id;
    execIds.add(execId);
    async function inspect() {
      const value = decode(await exchange("GET", `/exec/${execId}/json`, undefined, 200, "json"));
      if (
        !object(value) ||
        value.ID !== execId ||
        value.ContainerID !== desktop ||
        !object(value.ProcessConfig) ||
        value.ProcessConfig.entrypoint !== command[0] ||
        !equal(value.ProcessConfig.arguments, command.slice(1)) ||
        value.ProcessConfig.user !== (scan ? "root" : "abc") ||
        value.ProcessConfig.privileged !== scan ||
        value.ProcessConfig.tty !== false ||
        typeof value.Running !== "boolean" ||
        !Number.isInteger(value.ExitCode)
      )
        throw failure();
      return value;
    }
    if ((await inspect()).Running !== false) throw failure();
    await running(deadline.signal);
    const data = await exchange(
      "POST",
      `/exec/${execId}/start`,
      { Detach: false, Tty: false },
      200,
      "stream",
      scan ? 8 * 1024 * 1024 : 128 * 1024,
    );
    // EOF can precede process exit. Never infer retirement from attached HTTP.
    const exitedBy = Date.now() + 5000;
    for (;;) {
      const result = await inspect();
      if (!result.Running) {
        if (result.ExitCode !== 0) throw failure();
        break;
      }
      if (Date.now() >= exitedBy) throw failure();
      await delay(50, undefined, { signal: deadline.signal });
    }
    await running(deadline.signal);
    const streams = canaryDockerStreams(data, scan ? 8 * 1024 * 1024 : 65536, 0);
    return streams.stdout;
  }
  try {
    await running(deadline.signal);
    effects = true;
    await exchange(
      "PUT",
      `/containers/${desktop}/archive?${new URLSearchParams({ path: "/tmp", noOverwriteDirNonDir: "true" })}`,
      tar(
        [
          { name: posix.basename(scripts.scanner), data: assets.scanner },
          { name: posix.basename(scripts.worker), data: assets.worker },
        ],
        0,
      ),
      200,
      "empty",
    );
    const exercised = decode(
      await execute(["exercise", marker, clipboard, ready.surrogate, ready.challenge]),
    );
    if (
      !equal(exercised, {
        v: 1,
        type: "exercised",
        challenge: ready.challenge,
        files: controls.files,
      })
    )
      throw failure();
    const mounts = decode(await execute(["roots"]));
    if (
      !object(mounts) ||
      !equal(Object.keys(mounts).sort(), ["paths", "type", "v"]) ||
      mounts.v !== 1 ||
      mounts.type !== "roots" ||
      !Array.isArray(mounts.paths) ||
      mounts.paths.length > 4096 ||
      !mounts.paths.includes("/config") ||
      mounts.paths.some((p) => !path(p) || kernelPath(p))
    )
      throw failure();
    await running(deadline.signal);
    const changes = decode(
      await exchange("GET", `/containers/${desktop}/changes`, undefined, 200, "json"),
    );
    if (!Array.isArray(changes) || changes.length > 16384) throw failure();
    const roots = new Set<string>(mounts.paths);
    for (const change of changes) {
      if (
        !object(change) ||
        ![0, 1, 2].includes(change.Kind as number) ||
        (change.Path !== "/" && !path(change.Path))
      )
        throw failure();
      if (
        change.Kind !== 2 &&
        typeof change.Path === "string" &&
        change.Path !== "/" &&
        !kernelPath(change.Path)
      )
        roots.add(change.Path);
    }
    roots.add(controlDirectory);
    if (roots.size > 4096 || Buffer.byteLength(JSON.stringify([...roots])) > 256 * 1024)
      throw failure();
    const report = decode(
      await execute(
        [
          ready.syntheticSecret,
          marker,
          clipboard,
          ready.surrogate,
          "--files",
          ...[...roots].sort(),
        ],
        true,
      ),
    );
    const verdict = canaryScanVerdict(report, controls);
    if (!verdict.ok) throw failure();
    deadline.signal.throwIfAborted();
    return verdict;
  } catch {
    if (effects) await retire();
    throw failure();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
