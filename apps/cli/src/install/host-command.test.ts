import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { readHostCommand } from "./host-command.ts";

const streams: PassThrough[] = [];
afterEach(() => {
  for (const stream of streams.splice(0)) stream.destroy();
  mocks.spawn.mockReset();
  vi.useRealTimers();
});
function fixture(kind: "macos" | "docker-context" = "macos") {
  const child = Object.assign(new EventEmitter(), {
    pid: 123 as number | undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  streams.push(child.stdout, child.stderr);
  mocks.spawn.mockReturnValue(child);
  const controller = new AbortController();
  const input =
    kind === "macos" ? { kind } : { kind, env: { PATH: "/fixture", DOCKER_CONTEXT: "local" } };
  const work = readHostCommand(input, controller.signal);
  let settled = false;
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { child, controller, work, settled: () => settled };
}
async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

it("runs only the fixed macOS command with a minimal environment and waits past exit and EOF", async () => {
  const f = fixture();
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/sw_vers", ["-productVersion"], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    cwd: "/",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  f.child.emit("spawn");
  f.child.stdout.end("15.4\n");
  f.child.stderr.end();
  f.child.emit("exit", 0, null);
  await flush();
  expect(f.settled()).toBe(false);
  f.child.emit("close", 0, null);
  expect(await f.work).toBe("15.4\n");
  expect(f.child.kill).not.toHaveBeenCalled();
});

it("snapshots Docker context arguments and environment without a shell", async () => {
  const f = fixture("docker-context");
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith("docker", ["context", "inspect", "local"], {
    env: { PATH: "/fixture", DOCKER_CONTEXT: "local" },
    cwd: "/",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  f.child.stdout.write("[]");
  f.child.emit("close", 0, null);
  expect(await f.work).toBe("[]");
});

it.each(["abort", "timeout", "stdout", "stderr", "error", "pipe", "kill-failure"])(
  "drains actual close after %s instead of settling at interruption",
  async (fault) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const result = expect(f.work).rejects.toThrow("Host prerequisite command failed.");
    if (fault === "kill-failure")
      f.child.kill.mockImplementation(() => {
        throw new Error("private");
      });
    if (fault === "abort" || fault === "kill-failure") f.controller.abort();
    if (fault === "timeout") await vi.advanceTimersByTimeAsync(2500);
    if (fault === "stdout") f.child.stdout.write(Buffer.alloc(4097));
    if (fault === "stderr") f.child.stderr.write(Buffer.alloc(4097));
    if (fault === "error") f.child.emit("error", new Error("private subprocess details"));
    if (fault === "pipe") f.child.stdout.emit("error", new Error("private pipe details"));
    await flush();
    expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(f.settled()).toBe(false);
    f.child.emit("exit", 0, null);
    await flush();
    expect(f.settled()).toBe(false);
    f.child.emit("close", 0, null);
    await result;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.child.kill).toHaveBeenCalledOnce();
  },
);

it("counts stderr against the shared output cap and never returns stderr", async () => {
  const f = fixture("docker-context");
  f.child.stdout.write(Buffer.alloc(32 * 1024, "a"));
  f.child.stderr.write(Buffer.alloc(32 * 1024 + 1, "b"));
  f.child.emit("close", 0, null);
  await expect(f.work).rejects.toThrow("Host prerequisite command failed.");
});

it.each(["invalid-utf8", "exit-code", "signal", "late-abort"])(
  "rejects %s even after valid-looking stdout",
  async (fault) => {
    const f = fixture();
    f.child.stdout.write(fault === "invalid-utf8" ? Buffer.from([0xff]) : Buffer.from("15.4\n"));
    if (fault === "late-abort") {
      f.child.emit("exit", 0, null);
      f.controller.abort();
    }
    f.child.emit("close", fault === "exit-code" ? 1 : 0, fault === "signal" ? "SIGTERM" : null);
    await expect(f.work).rejects.toThrow("Host prerequisite command failed.");
  },
);

it("preserves only pre-spawn Docker ENOENT for the existing local socket fallback", async () => {
  const f = fixture("docker-context");
  f.child.pid = undefined;
  f.child.emit("error", Object.assign(new Error("private path"), { code: "ENOENT" }));
  await flush();
  expect(f.settled()).toBe(false);
  f.child.emit("close", -2, null);
  await expect(f.work).rejects.toMatchObject({
    code: "ENOENT",
    message: "Host prerequisite command failed.",
  });
});

it.each(["spawned", "pid", "macos"])(
  "does not grant Docker fallback for %s errors",
  async (fault) => {
    const f = fixture(fault === "macos" ? "macos" : "docker-context");
    if (fault !== "pid") f.child.pid = undefined;
    if (fault === "spawned") f.child.emit("spawn");
    f.child.emit("error", Object.assign(new Error("private"), { code: "ENOENT" }));
    f.child.emit("close", -2, null);
    const error = await f.work.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("code");
  },
);

it("does not start a command for a prior cancellation or invalid context", async () => {
  await expect(readHostCommand({ kind: "macos" }, AbortSignal.abort())).rejects.toThrow();
  for (const DOCKER_CONTEXT of ["bad\nname", "a".repeat(257)])
    await expect(
      readHostCommand(
        { kind: "docker-context", env: { DOCKER_CONTEXT } },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("sanitizes synchronous spawn failure without inventing a live child", async () => {
  mocks.spawn.mockImplementation(() => {
    throw new Error("private spawn details");
  });
  await expect(readHostCommand({ kind: "macos" }, new AbortController().signal)).rejects.toThrow(
    "Host prerequisite command failed.",
  );
});
