import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runLoginUnit,
  runServiceCommand,
  runServiceObservation,
  runUnitObservation,
  type ServiceObservation,
  type ServiceOperation,
} from "./service-command.ts";
import { type ServiceLocation, serviceLocation } from "./service-definition.ts";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));
afterEach(() => {
  spawn.mockReset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const location = serviceLocation(
  "/private/tmp/install",
  "/private/tmp/home",
  501,
  "e".repeat(32),
  "d".repeat(64),
).daemon;
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  spawn.mockReturnValue(child);
  return child;
}
it.each(["manageruid", "managername", "list"] as const)(
  "runs only fixed read-only %s arguments",
  async (operation) => {
    const child = fixture(),
      promise = runServiceObservation(operation, new AbortController().signal);
    expect(spawn).toHaveBeenCalledWith(
      "/bin/launchctl",
      [operation],
      expect.objectContaining({ cwd: "/", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }),
    );
    child.stdout.write("observation\n");
    child.emit("close", 0, null);
    expect(await promise).toEqual({ code: 0, stdout: "observation\n", stderr: "" });
  },
);
it("rejects an arbitrary observation command before launch", () => {
  expect(() =>
    runServiceObservation("bootout" as ServiceObservation, new AbortController().signal),
  ).toThrow();
  expect(spawn).not.toHaveBeenCalled();
});
it.each(["print", "bootout", "bootstrap", "kickstart"] as const)(
  "runs only the fixed %s command with a clean environment",
  async (operation) => {
    vi.stubEnv("NODE_OPTIONS", "secret");
    const child = fixture(),
      promise = runServiceCommand(location, operation, new AbortController().signal);
    const args =
      operation === "bootstrap"
        ? [operation, location.domain, location.file]
        : operation === "kickstart"
          ? [operation, "-p", location.target]
          : [operation, location.target];
    expect(spawn).toHaveBeenCalledWith("/bin/launchctl", args, {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.write("service output");
    child.stderr.write("diagnostic");
    child.emit("close", 0, null);
    expect(await promise).toEqual({ code: 0, stdout: "service output", stderr: "diagnostic" });
  },
);
it("preserves nonzero status for the lifecycle to interpret, without treating it as absent", async () => {
  const child = fixture(),
    result = runServiceCommand(location, "print", new AbortController().signal);
  child.emit("close", 5, null);
  expect((await result).code).toBe(5);
});
it("sanitizes synchronous process creation errors", async () => {
  spawn.mockImplementation(() => {
    throw new Error("private OS detail");
  });
  await expect(
    runServiceCommand(location, "bootstrap", new AbortController().signal),
  ).rejects.toThrow(/^The localDot service command did not complete reliably\.$/);
});
it.each([null, -1, 256, 0.5])("rejects invalid child exit status %s", async (code) => {
  const child = fixture(),
    result = runServiceCommand(location, "print", new AbortController().signal);
  const rejected = expect(result).rejects.toThrow("did not complete reliably");
  child.emit("close", code, null);
  await rejected;
});
it.each(["cancel", "timeout", "overflow", "error", "pipe-error", "signal", "bad-utf8"])(
  "refuses %s and settles only after child closure",
  async (kind) => {
    vi.useFakeTimers();
    const child = fixture(),
      controller = new AbortController();
    const error = new Error("cancel");
    let settled = false;
    const result = runServiceCommand(location, "bootout", controller.signal)
      .catch((e) => e)
      .finally(() => {
        settled = true;
      });
    if (kind === "cancel") controller.abort(error);
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(30_000);
    if (kind === "overflow") {
      child.stdout.write(Buffer.alloc(65_536));
      child.stderr.write(Buffer.alloc(65_537));
    }
    if (kind === "error") child.emit("error", new Error("private diagnostic"));
    if (kind === "pipe-error") child.stdout.emit("error", new Error("pipe"));
    if (kind === "bad-utf8") child.stdout.write(Buffer.from([0xff]));
    await Promise.resolve();
    expect(settled).toBe(false);
    if (["cancel", "timeout", "overflow", "pipe-error"].includes(kind))
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", kind === "signal" ? null : 0, kind === "signal" ? "SIGTERM" : null);
    const failure = await result;
    expect(failure).toBeInstanceOf(Error);
    if (kind === "cancel") expect(failure).toBe(error);
    else expect(failure.message).toBe("The localDot service command did not complete reliably.");
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("does not spawn after cancellation or with an invalid operation or target", () => {
  const controller = new AbortController();
  controller.abort(new Error("cancel"));
  expect(() => runServiceCommand(location, "print", controller.signal)).toThrow("cancel");
  const signal = new AbortController().signal;
  for (const patch of [
    { target: "gui/501" },
    { domain: "system" },
    { domain: "gui/0" },
    { label: "com.apple.finder" },
    { role: "keyd" as const },
    { file: "/private/tmp/install/services/../daemon.plist" },
    { file: "/private/tmp/install/services/foreign.plist" },
  ])
    expect(() =>
      runServiceCommand({ ...location, ...patch } as ServiceLocation, "bootout", signal),
    ).toThrow();
  expect(() => runServiceCommand(location, "kill" as ServiceOperation, signal)).toThrow();
  expect(spawn).not.toHaveBeenCalled();
});

describe("systemd user units", () => {
  const uid = process.getuid?.() ?? 501;
  const unit = serviceLocation(
    "/private/tmp/install",
    "/private/tmp/home",
    uid,
    "e".repeat(32),
    "d".repeat(64),
    "systemd",
  ).keyd;
  const systemctl = (args: string[]) => [
    "/usr/bin/systemctl",
    ["--user", ...args],
    {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", XDG_RUNTIME_DIR: `/run/user/${uid}` },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ];
  // Each spawned systemctl answers in turn with [code, stdout].
  function answers(...replies: [number, string][]) {
    spawn.mockImplementation(() => {
      const [code, stdout] = replies.shift() ?? [1, ""];
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      queueMicrotask(() => {
        child.stdout.end(stdout);
        child.stderr.end();
        child.emit("close", code, null);
      });
      return child;
    });
  }

  it("links the unit file as bootstrap and asks this user's manager, not the environment's", async () => {
    vi.stubEnv("XDG_RUNTIME_DIR", "/tmp/elsewhere");
    answers([0, ""]);
    await runServiceCommand(unit, "bootstrap", new AbortController().signal);
    expect(spawn.mock.calls).toEqual([systemctl(["link", unit.file])]);
  });

  it("starts the unit and reports its main PID the way kickstart -p does", async () => {
    answers([0, ""], [0, "4242\n"]);
    expect(await runServiceCommand(unit, "kickstart", new AbortController().signal)).toEqual({
      code: 0,
      stdout: "4242\n",
      stderr: "",
    });
    expect(spawn.mock.calls).toEqual([
      systemctl(["start", unit.target]),
      systemctl(["show", "--property=MainPID", "--value", unit.target]),
    ]);
  });

  it("stops, then unlinks, as bootout; a failed stop is returned as is", async () => {
    answers([0, ""], [0, ""]);
    await runServiceCommand(unit, "bootout", new AbortController().signal);
    expect(spawn.mock.calls).toEqual([
      systemctl(["stop", unit.target]),
      systemctl(["disable", unit.target]),
    ]);
    spawn.mockReset();
    answers([5, ""]);
    expect((await runServiceCommand(unit, "bootout", new AbortController().signal)).code).toBe(5);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("observes only an owned unit, and toggles only the login unit", async () => {
    answers([0, "LoadState=loaded\n"]);
    await runUnitObservation(unit, new AbortController().signal);
    expect(spawn.mock.calls[0]).toEqual(
      systemctl(["show", "--property=LoadState,ActiveState,MainPID", unit.target]),
    );
    expect(() =>
      runUnitObservation({ ...unit, target: "ssh.service" }, new AbortController().signal),
    ).toThrow();
    expect(() => runLoginUnit("enable", unit.target, uid, new AbortController().signal)).toThrow();
    expect(() =>
      runLoginUnit(
        "enable",
        unit.target.replace(".keyd.", ".login."),
        uid + 1,
        new AbortController().signal,
      ),
    ).toThrow();
  });

  it("refuses a location whose manager or unit was changed", () => {
    expect(() =>
      runServiceCommand({ ...unit, manager: "launchd" }, "print", new AbortController().signal),
    ).toThrow();
    expect(() =>
      runServiceCommand(
        { ...unit, file: "/private/tmp/foreign.service" },
        "bootstrap",
        new AbortController().signal,
      ),
    ).toThrow();
  });
});
