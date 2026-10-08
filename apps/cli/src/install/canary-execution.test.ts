import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  CanaryOperation,
  canaryResourceLabels,
  canaryResourceName,
} from "../../../../packages/protocol/src/canary-operation.ts";
import { CanaryReady } from "../../../../packages/protocol/src/canary-process.ts";
import { CANARY_FORMS } from "../../../daemon/src/diagnostics/canary-verdict.ts";
import { runCanaryDesktopScan } from "./canary-execution.ts";

const mocks = vi.hoisted(() => ({ request: vi.fn(), cleanup: vi.fn() }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("./canary-cleanup-client.ts", () => ({ canaryCleanupClient: mocks.cleanup }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
function frame(value: Buffer | string, stream = 1) {
  const body = Buffer.from(value),
    header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
type Call = {
  method: string;
  path: string;
  payload: Buffer;
  command?: string[];
  close: () => void;
};
type Reply = {
  status: number;
  body: Buffer;
  content: string;
  complete: boolean;
  headers: Record<string, string>;
  stall: boolean;
  holdClose: boolean;
};
function fixture(hook?: (call: Call, reply: Reply) => void) {
  const operation = CanaryOperation.parse({
    v: 1,
    owner: "a".repeat(32),
    engineId: "engine-fixture",
    runId: "01234567-89ab-4cde-8fab-0123456789ab",
    cellId: "01JXYZ00000000000000000001",
    phase: "active",
    directory: { device: "1", inode: "2" },
    images: {
      desktop: {
        ref: `ghcr.io/fixture/localdot-desktop@sha256:${"a".repeat(64)}`,
        id: `sha256:${"b".repeat(64)}`,
      },
      gate: {
        ref: `ghcr.io/fixture/localdot-gate@sha256:${"c".repeat(64)}`,
        id: `sha256:${"d".repeat(64)}`,
      },
    },
    resources: {
      desktop: "1".repeat(64),
      gate: "2".repeat(64),
      internal: "3".repeat(64),
      egress: "4".repeat(64),
      home: true,
    },
  });
  const ready = CanaryReady.parse({
    v: 1,
    type: "ready",
    runId: operation.runId,
    cellId: operation.cellId,
    port: 49123,
    proxyToken: "t".repeat(43),
    caCertPem: `-----BEGIN CERTIFICATE-----\n${"A".repeat(128)}\n-----END CERTIFICATE-----\n`,
    surrogate: `ld_key_${"a".repeat(22)}_${"b".repeat(6)}`,
    syntheticSecret: `canary-${"e".repeat(64)}`,
    challenge: "a".repeat(32),
    url: `https://canary.localdot.invalid/v1/canary/${"a".repeat(32)}`,
  });
  const container = {
    Id: operation.resources.desktop,
    Name: `/${canaryResourceName(operation.runId, "desktop")}`,
    Image: operation.images.desktop.id,
    Config: {
      Image: operation.images.desktop.ref,
      Labels: canaryResourceLabels(operation, "desktop"),
    },
    State: { Running: true, Paused: false, Restarting: false, Dead: false },
  };
  const engine = { id: operation.engineId, operatingSystem: "linux", architecture: "arm64" };
  const cleanup = {
    engine: vi.fn(async (_signal: AbortSignal) => ({ ...engine })),
    inspect: vi.fn(async () => structuredClone(container) as unknown),
    stop: vi.fn(async (_id: string, _signal: AbortSignal) => {
      container.State.Running = false;
    }),
  };
  mocks.cleanup.mockReturnValue(cleanup);
  const calls: Call[] = [],
    commands = new Map<string, string[]>(),
    creates: Record<string, unknown>[] = [],
    controller = new AbortController();
  const assets = { scanner: Buffer.from("scanner fixture"), worker: Buffer.from("worker fixture") };
  mocks.request.mockImplementation((options, callback) => {
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    let response: Readable | undefined,
      closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        req.emit("close");
      }
    };
    const reply: Reply = {
      status: 200,
      body: Buffer.alloc(0),
      content: "application/json",
      complete: true,
      headers: {},
      stall: false,
      holdClose: false,
    };
    req.destroy.mockImplementation(() => {
      if (!reply.holdClose) queueMicrotask(close);
    });
    req.end.mockImplementation((payload?: Buffer) => {
      const call: Call = {
        method: options.method,
        path: options.path,
        payload: payload ?? Buffer.alloc(0),
        close,
      };
      const execId = call.path.match(/\/exec\/([a-f0-9]{64})\//)?.[1];
      if (call.path.endsWith("/exec")) {
        const body = JSON.parse(call.payload.toString());
        creates.push(body);
        const id = creates.length.toString(16).padStart(64, "0");
        commands.set(id, body.Cmd);
        call.command = body.Cmd;
        reply.status = 201;
        reply.body = json({ Id: id });
      } else if (execId) {
        call.command = commands.get(execId);
        if (call.path.endsWith("/json"))
          reply.body = json({
            ID: execId,
            ContainerID: operation.resources.desktop,
            ProcessConfig: {
              entrypoint: call.command?.[0],
              arguments: call.command?.slice(1),
              privileged: call.command?.[4]?.startsWith("canary-") ?? false,
              tty: false,
              user: call.command?.[4]?.startsWith("canary-") ? "root" : "abc",
            },
            Running: false,
            ExitCode: 0,
          });
        else {
          const command = call.command ?? [],
            mode = command[4];
          reply.content = "application/vnd.docker.raw-stream";
          if (mode === "exercise") {
            const marker = command[5];
            reply.body = frame(
              json({
                v: 1,
                type: "exercised",
                challenge: ready.challenge,
                files: CANARY_FORMS.map((form, i) => ({
                  form,
                  path: `/tmp/localdot-canary-${marker}/${i}-${form}`,
                })),
              }),
            );
          } else if (mode === "roots")
            reply.body = frame(
              json({ v: 1, type: "roots", paths: ["/config", "/tmp", "/dev/shm"] }),
            );
          else {
            const marker = command[5],
              clipboard = command[6],
              surrogate = command[7];
            reply.body = frame(
              json({
                processes: 21,
                bytes: 105 * 1024 * 1024,
                files: 101,
                fileBytes: 4096,
                unreadableMemory: 0,
                fileErrors: [],
                processErrors: [],
                hits: [
                  ...CANARY_FORMS.map(
                    (form, i) =>
                      `${marker}|${form}|file /tmp/localdot-canary-${marker}/${i}-${form}`,
                  ),
                  `${marker}|raw|environ`,
                  `${marker}|raw|cmdline`,
                  `${surrogate}|raw|environ`,
                  ...[marker, surrogate, clipboard].map((value) => `${value}|raw|memory`),
                ],
                memoryReads: Array.from({ length: 21 }, (_, i) => ({
                  pid: i + 1,
                  comm: i === 2 ? "xclip" : "fixture",
                  bytes: 5 * 1024 * 1024,
                })),
                memoryHits: [marker, surrogate, clipboard].map((needle, i) => ({
                  pid: i + 1,
                  comm: i === 2 ? "xclip" : "fixture",
                  needle,
                  form: "raw",
                })),
              }),
            );
          }
        }
      } else if (call.path.endsWith("/changes"))
        reply.body = json([
          { Path: "/config/a new\nfile", Kind: 1 },
          { Path: "/proc", Kind: 0 },
          { Path: "/sys", Kind: 0 },
          { Path: "/", Kind: 0 },
          { Path: "/deleted", Kind: 2 },
        ]);
      calls.push(call);
      hook?.(call, reply);
      response = Object.assign(
        Readable.from(
          Array.from({ length: Math.ceil(reply.body.length / 7) }, (_, i) =>
            reply.body.subarray(i * 7, i * 7 + 7),
          ),
        ),
        {
          statusCode: reply.status,
          complete: reply.complete,
          headers: { "content-type": reply.content, ...reply.headers },
        },
      );
      response.on("error", () => {});
      if (!reply.stall) queueMicrotask(() => callback(response));
    });
    options.signal.addEventListener("abort", () => {
      req.emit("error", options.signal.reason);
      response?.destroy(options.signal.reason);
      req.destroy();
    });
    return req;
  });
  return {
    operation,
    ready,
    container,
    engine,
    cleanup,
    calls,
    creates,
    assets,
    controller,
    run: () =>
      runCanaryDesktopScan("/fixture/docker.sock", operation, ready, assets, controller.signal),
  };
}

it("uploads only verified assets, runs fixed unprivileged controls then a privileged scanner and returns private-free coverage", async () => {
  const f = fixture();
  expect(await f.run()).toEqual({
    ok: true,
    reason: "passed",
    coverage: { processes: 21, memoryBytes: 105 * 1024 * 1024, files: 101, fileBytes: 4096 },
  });
  expect(f.cleanup.stop).not.toHaveBeenCalled();
  expect(f.creates).toHaveLength(3);
  expect(f.creates.map((value) => [value.User, value.Privileged])).toEqual([
    ["abc", false],
    ["abc", false],
    ["root", true],
  ]);
  for (const value of f.creates)
    expect(value).toMatchObject({
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: "/",
      Env: ["PATH=/usr/bin:/bin", "LANG=C.UTF-8", "DISPLAY=:1"],
    });
  const scan = f.creates[2]?.Cmd as string[];
  expect(scan.slice(0, 3)).toEqual(["/usr/bin/python3", "-I", "-B"]);
  expect(scan).toContain("/config/a new\nfile");
  for (const skipped of ["/", "/proc", "/sys", "/deleted"]) expect(scan).not.toContain(skipped);
  expect(f.calls.filter((call) => call.payload.includes(f.ready.syntheticSecret))).toHaveLength(1);
  expect(f.calls[0]?.payload.toString()).not.toContain(f.ready.syntheticSecret);
  expect(f.calls.filter((call) => call.path.endsWith("/json"))).toHaveLength(6);
  expect(
    f.calls.every((call) => !call.path.includes("kill") && !call.path.includes("remove")),
  ).toBe(true);
});
it.each(["engine", "label", "image", "name", "paused", "missing-resource", "wrong-run"])(
  "refuses %s before effects",
  async (fault) => {
    const f = fixture();
    if (fault === "engine") f.engine.id = "other";
    if (fault === "label") f.container.Config.Labels["localdot.install-owner"] = "other";
    if (fault === "image") f.container.Image = `sha256:${"f".repeat(64)}`;
    if (fault === "name") f.container.Name = "/foreign";
    if (fault === "paused") f.container.State.Paused = true;
    if (fault === "missing-resource") f.operation.resources.gate = null;
    if (fault === "wrong-run") f.ready = { ...f.ready, cellId: "01JXYZ00000000000000000002" }; // explicit call below
    await expect(
      runCanaryDesktopScan(
        "/fixture/docker.sock",
        f.operation,
        f.ready,
        f.assets,
        f.controller.signal,
      ),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    expect(f.cleanup.stop).not.toHaveBeenCalled();
  },
);
it.each([
  "upload-status",
  "exec-id",
  "exec-container",
  "exec-command",
  "exec-user",
  "exec-privilege",
  "exec-running-before-start",
  "exit-code",
  "wrong-challenge",
  "missing-form",
  "roots",
  "changes",
  "leak",
  "coverage",
])("retires the exact desktop after %s failure", async (fault) => {
  const f = fixture((call, reply) => {
    if (fault === "upload-status" && call.method === "PUT") reply.status = 500;
    if (fault === "exec-id" && call.path.endsWith("/exec")) reply.body = json({ Id: "short" });
    if (call.path.endsWith("/json")) {
      const value = JSON.parse(reply.body.toString());
      if (fault === "exec-container") value.ContainerID = "f".repeat(64);
      if (fault === "exec-command") value.ProcessConfig.entrypoint = "/bin/sh";
      if (fault === "exec-user") value.ProcessConfig.user = "foreign";
      if (fault === "exec-privilege")
        value.ProcessConfig.privileged = !value.ProcessConfig.privileged;
      if (fault === "exec-running-before-start") value.Running = true;
      if (fault === "exit-code") value.ExitCode = 7;
      reply.body = json(value);
    }
    if (call.path.endsWith("/start") && call.command?.[4] === "exercise") {
      const value = JSON.parse(reply.body.subarray(8).toString());
      if (fault === "wrong-challenge") value.challenge = "wrong";
      if (fault === "missing-form") value.files.pop();
      reply.body = frame(json(value));
    }
    if (fault === "roots" && call.path.endsWith("/start") && call.command?.[4] === "roots")
      reply.body = frame(json({ v: 1, type: "roots", paths: ["/config", "/proc"] }));
    if (fault === "changes" && call.path.endsWith("/changes"))
      reply.body = json([{ Path: "/tmp/../home", Kind: 1 }]);
    if (call.path.endsWith("/start") && call.command?.[4]?.startsWith("canary-")) {
      const value = JSON.parse(reply.body.subarray(8).toString());
      if (fault === "leak") value.hits.push(`${call.command[4]}|raw|file /tmp/leak`);
      if (fault === "coverage") value.fileErrors.push("fixture inaccessible file");
      reply.body = frame(json(value));
    }
  });
  await expect(f.run()).rejects.toThrow("scan could not be verified");
  expect(f.cleanup.stop).toHaveBeenCalledExactlyOnceWith(
    f.operation.resources.desktop,
    expect.any(AbortSignal),
  );
  expect(f.container.State.Running).toBe(false);
});
it.each([
  "status",
  "type",
  "encoding",
  "length",
  "incomplete",
  "stderr",
  "stream",
  "reserved",
  "truncated",
  "utf8",
])("rejects %s attached output and retires before returning", async (fault) => {
  const f = fixture((call, reply) => {
    if (!call.path.endsWith("/start")) return;
    if (fault === "status") reply.status = 302;
    if (fault === "type") reply.content = "text/plain";
    if (fault === "encoding") reply.headers["content-encoding"] = "gzip";
    if (fault === "length") reply.headers["content-length"] = "999999999";
    if (fault === "incomplete") reply.complete = false;
    if (fault === "stderr") reply.body = Buffer.concat([reply.body, frame("private fixture", 2)]);
    if (fault === "stream") reply.body[0] = 3;
    if (fault === "reserved") reply.body[1] = 1;
    if (fault === "truncated") reply.body = reply.body.subarray(0, -1);
    if (fault === "utf8") reply.body = frame(Buffer.from([0xff]));
  });
  await expect(f.run()).rejects.toThrow("scan could not be verified");
  expect(f.cleanup.stop).toHaveBeenCalledTimes(1);
});
it("waits for actual request closure before retiring an interrupted exec", async () => {
  let release: (() => void) | undefined;
  const f = fixture((call, reply) => {
    if (call.path.endsWith("/start")) {
      reply.stall = true;
      reply.holdClose = true;
      release = call.close;
    }
  });
  const result = f.run().then(
    () => "unexpected",
    (error: Error) => error.message,
  );
  for (let i = 0; i < 20 && !release; i++) await setImmediate();
  expect(release).toBeTypeOf("function");
  f.controller.abort();
  await setImmediate();
  expect(f.cleanup.stop).not.toHaveBeenCalled();
  release?.();
  expect(await result).toContain("scan could not be verified");
  expect(f.cleanup.stop.mock.calls[0]?.[1].aborted).toBe(false);
});
it("does not confuse attached EOF with remote process exit", async () => {
  let started = false,
    observed = 0;
  const f = fixture((call, reply) => {
    if (call.path.endsWith("/start")) started = true;
    if (call.path.endsWith("/json") && started && observed++ === 0) {
      const value = JSON.parse(reply.body.toString());
      value.Running = true;
      reply.body = json(value);
    }
  });
  expect((await f.run()).ok).toBe(true);
  expect(f.calls.filter((call) => call.path.endsWith("/json"))).toHaveLength(7);
});
it.each(["attached-timeout", "process-stays-alive"])(
  "bounds %s and stops the recorded desktop",
  async (fault) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let started = false;
    const f = fixture((call, reply) => {
      if (call.path.endsWith("/start")) {
        started = true;
        if (fault === "attached-timeout") reply.stall = true;
      }
      if (fault === "process-stays-alive" && started && call.path.endsWith("/json")) {
        const value = JSON.parse(reply.body.toString());
        value.Running = true;
        reply.body = json(value);
      }
    });
    const result = f.run().then(
      () => "unexpected",
      (error: Error) => error.message,
    );
    for (let i = 0; i < 20 && !started; i++) await setImmediate();
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(fault === "attached-timeout" ? 180_001 : 5100);
    expect(await result).toContain("scan could not be verified");
    expect(f.cleanup.stop).toHaveBeenCalledTimes(1);
  },
);
it("rejects cancellation after response EOF while actual request closure is pending", async () => {
  let release: (() => void) | undefined;
  const f = fixture((call, reply) => {
    if (call.path.endsWith("/start")) {
      reply.holdClose = true;
      release = call.close;
    }
  });
  const result = f.run().then(
    () => "unexpected",
    (error: Error) => error.message,
  );
  for (let i = 0; i < 20 && !release; i++) await setImmediate();
  expect(release).toBeTypeOf("function");
  await setImmediate();
  f.controller.abort();
  release?.();
  expect(await result).toContain("scan could not be verified");
  expect(f.cleanup.stop).toHaveBeenCalledTimes(1);
});
it("never claims completion until the independent desktop retirement settles", async () => {
  const f = fixture((call, reply) => {
    if (call.method === "PUT") reply.status = 500;
  });
  let finish: (() => void) | undefined,
    settled = false;
  f.cleanup.stop.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          f.container.State.Running = false;
          resolve();
        };
      }),
  );
  const result = f
    .run()
    .then(
      () => "unexpected",
      (error: Error) => error.message,
    )
    .finally(() => {
      settled = true;
    });
  for (let i = 0; i < 20 && !finish; i++) await setImmediate();
  expect(finish).toBeTypeOf("function");
  expect(settled).toBe(false);
  finish?.();
  expect(await result).toContain("scan could not be verified");
});
it("keeps the run failed but accepts a lost stop reply only after fresh stopped evidence", async () => {
  const f = fixture((call, reply) => {
    if (call.method === "PUT") reply.status = 500;
  });
  f.cleanup.stop.mockImplementation(async () => {
    f.container.State.Running = false;
    throw new Error("lost reply");
  });
  await expect(f.run()).rejects.toThrow("scan could not be verified");
  expect(f.cleanup.inspect.mock.calls.length).toBeGreaterThan(2);
});
it.each(["still-running", "replacement", "engine-changed"])(
  "requires recovery when retirement has %s",
  async (fault) => {
    const f = fixture((call, reply) => {
      if (call.method !== "PUT") return;
      reply.status = 500;
      if (fault === "replacement") f.container.Id = "f".repeat(64);
      if (fault === "engine-changed") f.engine.id = "other";
    });
    f.cleanup.stop.mockImplementation(async () => {});
    await expect(f.run()).rejects.toThrow("requires recovery");
    if (fault !== "still-running") expect(f.cleanup.stop).not.toHaveBeenCalled();
  },
);
