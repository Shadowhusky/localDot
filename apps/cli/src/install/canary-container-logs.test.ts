import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  CanaryOperation,
  canaryResourceLabels,
  canaryResourceName,
} from "../../../../packages/protocol/src/canary-operation.ts";
import { withCanaryContainerLogs } from "./canary-container-logs.ts";

const mocks = vi.hoisted(() => ({ cleanup: vi.fn(), wire: vi.fn() }));
vi.mock("./canary-cleanup-client.ts", () => ({ canaryCleanupClient: mocks.cleanup }));
vi.mock("./canary-docker-exchange.ts", async (original) => ({
  ...(await original<typeof import("./canary-docker-exchange.ts")>()),
  canaryDockerExchange: mocks.wire,
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
type Role = "desktop" | "gate";
const roles = ["desktop", "gate"] as const;
const json = (v: unknown) => Buffer.from(JSON.stringify(v));
function frame(bytes: Buffer | string, stream: number) {
  const body = Buffer.from(bytes),
    header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
type Call = {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  role?: Role;
  kind: string;
  limit?: number;
};
function fixture(hook?: (call: Call, value: Buffer) => Buffer | Promise<Buffer>) {
  const operation = CanaryOperation.parse({
    v: 1,
    owner: "a".repeat(32),
    runId: "01234567-89ab-4cde-8fab-0123456789ab",
    cellId: "01JXYZ00000000000000000001",
    engineId: "fixture-engine",
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
  function container(role: Role) {
    const labels: Record<string, string> = canaryResourceLabels(operation, role);
    return {
      Id: operation.resources[role] ?? "",
      Name: `/${canaryResourceName(operation.runId, role)}`,
      Config: { Image: operation.images[role].ref, Labels: labels },
      Image: operation.images[role].id,
      State: { Running: true, Paused: false, Restarting: false, Dead: false },
    };
  }
  const containers = { desktop: container("desktop"), gate: container("gate") };
  const engine = { id: operation.engineId, operatingSystem: "linux", architecture: "arm64" },
    events: string[] = [],
    calls: Call[] = [];
  const cleanup = {
    engine: vi.fn(async () => ({ ...engine })),
    inspect: vi.fn(
      async (role: Role, _reference: string, _signal: AbortSignal) =>
        structuredClone(containers[role]) as unknown,
    ),
    stop: vi.fn(async (id: string, _signal: AbortSignal) => {
      const role = roles.find((role) => containers[role].Id === id);
      if (!role) throw new Error("unknown ID");
      events.push(`stop:${role}`);
      containers[role].State.Running = false;
    }),
  };
  mocks.cleanup.mockReturnValue(cleanup);
  const output = { desktop: { stdout: "", stderr: "" }, gate: { stdout: "", stderr: "" } };
  const commands = new Map<string, { role: Role; command: string[] }>();
  let active: AbortSignal;
  mocks.wire.mockImplementation((_socket: string, signal: AbortSignal) => {
    active = signal;
    return async (
      method: string,
      path: string,
      body: Record<string, unknown> | undefined,
      _status: number,
      kind: string,
      limit?: number,
    ) => {
      const role = roles.find((role) => path.includes(`/containers/${containers[role].Id}/`)),
        call: Call = { method, path, body, role, kind, limit };
      let reply = Buffer.alloc(0);
      if (path.endsWith("/exec")) {
        if (!role) throw new Error("unknown container");
        const id = (commands.size + 1).toString(16).padStart(64, "0"),
          command = body?.Cmd as string[];
        commands.set(id, { role, command });
        reply = json({ Id: id });
      } else if (path.includes("/exec/")) {
        const id = path.split("/")[2] ?? "",
          entry = commands.get(id);
        if (!entry) throw new Error("unknown exec");
        call.role = entry.role;
        if (path.endsWith("/json"))
          reply = json({
            ID: id,
            ContainerID: containers[entry.role].Id,
            Running: false,
            ExitCode: 0,
            ProcessConfig: {
              entrypoint: entry.command[0],
              arguments: entry.command.slice(1),
              user: "root",
              privileged: true,
              tty: false,
            },
          });
        else {
          const stdout = entry.command[4] ?? "",
            stderr = entry.command[5] ?? "";
          output[entry.role].stdout += `${stdout}\n`;
          output[entry.role].stderr += `${stderr}\n`;
          events.push(`${stdout.includes("-start-") ? "start" : "end"}:${entry.role}`);
        }
      } else if (path.includes("/logs?")) {
        if (!role) throw new Error("unknown container");
        expect(containers.desktop.State.Running || containers.gate.State.Running).toBe(false);
        events.push(`logs:${role}`);
        reply = Buffer.concat([frame(output[role].stdout, 1), frame(output[role].stderr, 2)]);
      }
      calls.push(call);
      return hook ? hook(call, reply) : reply;
    };
  });
  const controller = new AbortController();
  const work = vi.fn(async (_signal: AbortSignal) => {
    events.push("work");
    output.desktop.stdout += "ordinary desktop output\n";
    output.gate.stderr += "ordinary gate output\n";
    return "scan result";
  });
  return {
    operation,
    containers,
    engine,
    cleanup,
    events,
    calls,
    output,
    controller,
    work,
    active: () => active,
    run: () => withCanaryContainerLogs("/fixture/docker.sock", operation, controller.signal, work),
  };
}

it("brackets work with distinct per-stream controls and collects full separated logs only after both containers stop", async () => {
  const f = fixture(),
    result = await f.run();
  expect(result.value).toBe("scan result");
  expect(f.events).toEqual([
    "start:desktop",
    "start:gate",
    "work",
    "end:desktop",
    "end:gate",
    "stop:desktop",
    "stop:gate",
    "logs:desktop",
    "logs:gate",
  ]);
  for (const role of roles)
    for (const stream of ["stdout", "stderr"] as const) {
      const text = result.logs[role][stream].toString();
      expect(text).toMatch(new RegExp(`log-${role}-${stream}-start-[a-f0-9]{32}`));
      expect(text).toMatch(new RegExp(`log-${role}-${stream}-end-[a-f0-9]{32}`));
    }
  for (const call of f.calls.filter((call) => call.path.endsWith("/exec"))) {
    expect(call.body).toMatchObject({
      Privileged: true,
      User: "root",
      Tty: false,
      AttachStdin: false,
      WorkingDir: "/",
      Env: ["PATH=/usr/bin:/bin", "LANG=C"],
    });
    const command = call.body?.Cmd as string[];
    expect(command.slice(0, 4)).toEqual([
      "/bin/sh",
      "-c",
      'set -eu; printf "%s\\n" "$1" > /proc/1/fd/1; printf "%s\\n" "$2" > /proc/1/fd/2',
      "localdot-log-control",
    ]);
  }
  for (const call of f.calls.filter((call) => call.path.includes("/logs?")))
    expect(call.path).toContain("stdout=true&stderr=true&timestamps=false&follow=false&tail=all");
  expect(result.logs.desktop.stdout.toString()).toContain("ordinary desktop output");
  expect(result.logs.gate.stderr.toString()).toContain("ordinary gate output");
});
it.each(["engine", "image", "labels", "id", "running"])(
  "refuses wrong %s before work or mutation",
  async (fault) => {
    const f = fixture();
    if (fault === "engine") f.engine.id = "foreign";
    if (fault === "image") f.containers.gate.Image = "foreign";
    if (fault === "labels") f.containers.gate.Config.Labels["localdot.canary-run"] = "foreign";
    if (fault === "id") f.containers.gate.Id = "f".repeat(64);
    if (fault === "running") f.containers.gate.State.Running = false;
    await expect(f.run()).rejects.toThrow("logs could not be verified");
    expect(f.work).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
    expect(f.cleanup.stop).not.toHaveBeenCalled();
  },
);
it.each(["id", "container", "command", "user", "privilege", "tty", "exit", "stderr"])(
  "retires both after invalid exec %s evidence",
  async (fault) => {
    const f = fixture((call, reply) => {
      if (fault === "id" && call.path.endsWith("/exec")) return json({ Id: "short" });
      if (call.path.endsWith("/json")) {
        const value = JSON.parse(reply.toString());
        if (fault === "container") value.ContainerID = "f".repeat(64);
        if (fault === "command") value.ProcessConfig.entrypoint = "/bin/other";
        if (fault === "user") value.ProcessConfig.user = "nobody";
        if (fault === "privilege") value.ProcessConfig.privileged = false;
        if (fault === "tty") value.ProcessConfig.tty = true;
        if (fault === "exit") value.ExitCode = 3;
        return json(value);
      }
      if (fault === "stderr" && call.path.endsWith("/start")) return frame("private fixture", 2);
      return reply;
    });
    await expect(f.run()).rejects.toThrow("logs could not be verified");
    expect(f.cleanup.stop.mock.calls.map(([id]) => id)).toEqual([
      f.operation.resources.desktop,
      f.operation.resources.gate,
    ]);
    expect(f.work).not.toHaveBeenCalled();
  },
);
it.each(["truncated", "stream", "restarted", "missing-file-control"])(
  "cannot pass %s final log evidence",
  async (fault) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const f = fixture((call, reply) => {
      if (!call.path.includes("/logs?")) return reply;
      if (fault === "truncated") return reply.subarray(0, -1);
      if (fault === "stream") {
        reply[0] = 3;
        return reply;
      }
      if (fault === "restarted") {
        f.containers.desktop.State.Running = true;
        return reply;
      }
      return Buffer.concat([frame("missing start marker", 1), frame(f.output.desktop.stderr, 2)]);
    });
    const result = f.run().then(
      () => "unexpected",
      (e: Error) => e.message,
    );
    for (let i = 0; i < 20 && !f.events.includes("logs:desktop"); i++) await setImmediate();
    await vi.advanceTimersByTimeAsync(5100);
    expect(await result).toContain("logs could not be verified");
  },
);
it("allows bounded log visibility delay but never drops a stream or a start control", async () => {
  let reads = 0;
  const f = fixture((call, reply) =>
    call.path.includes("/logs?") && reads++ === 0 ? Buffer.alloc(0) : reply,
  );
  expect((await f.run()).value).toBe("scan result");
  expect(reads).toBe(3);
});
it("waits for failing work to drain before independently retiring containers", async () => {
  const f = fixture();
  let settle: (() => void) | undefined;
  f.work.mockImplementation(
    () =>
      new Promise<string>((_resolve, reject) => {
        settle = () => reject(new Error("private fixture"));
      }),
  );
  const result = f.run().then(
    () => "unexpected",
    (e: Error) => e.message,
  );
  for (let i = 0; i < 20 && !settle; i++) await setImmediate();
  expect(settle).toBeTypeOf("function");
  f.controller.abort();
  await setImmediate();
  expect(f.active().aborted).toBe(true);
  expect(f.cleanup.stop).not.toHaveBeenCalled();
  settle?.();
  expect(await result).toContain("logs could not be verified");
  expect(f.cleanup.stop).toHaveBeenCalledTimes(2);
  expect(f.cleanup.stop.mock.calls.every(([, signal]) => !signal.aborted)).toBe(true);
});
it("attempts both owned retirements even if the first fails and never treats that as a pass", async () => {
  const f = fixture();
  f.cleanup.stop.mockImplementation(async (id) => {
    if (id === f.operation.resources.desktop) throw new Error("lost stop");
    f.containers.gate.State.Running = false;
  });
  await expect(f.run()).rejects.toThrow("require recovery");
  expect(f.cleanup.stop).toHaveBeenCalledTimes(2);
  expect(f.events.some((event) => event.startsWith("logs:"))).toBe(false);
});
it("accepts a lost stop reply only with fresh stopped state and still preserves all logs", async () => {
  const f = fixture();
  f.cleanup.stop.mockImplementation(async (id) => {
    const role = id === f.operation.resources.desktop ? "desktop" : "gate";
    f.containers[role].State.Running = false;
    throw new Error("lost reply");
  });
  expect((await f.run()).value).toBe("scan result");
});
it("refuses a replaced gate without issuing a stop to that foreign identity", async () => {
  const f = fixture();
  f.work.mockImplementation(async () => {
    f.containers.gate.Config.Labels["localdot.install-owner"] = "foreign";
    throw new Error("fixture");
  });
  await expect(f.run()).rejects.toThrow("require recovery");
  expect(f.cleanup.stop.mock.calls.map(([id]) => id)).toEqual([f.operation.resources.desktop]);
});
