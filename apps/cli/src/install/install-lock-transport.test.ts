import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  keydCanaryLeaseAcquirer,
  keydLockAcquirer,
  keydServiceLeaseAcquirer,
  ServiceLeaseBusy,
} from "./install-lock.ts";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));
afterEach(() => {
  spawn.mockReset();
  vi.useRealTimers();
});
const scope = {
  state: "/private/tmp/state",
  home: "/private/tmp/home",
  ownerId: "a".repeat(32),
  role: "daemon" as const,
};
const nonce = "b".repeat(64);
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    kill: vi.fn(() => true),
  });
  spawn.mockReturnValue(child);
  return child;
}
it.each([false, true])(
  "acquires a canary directory lease with a nonce-bound receipt (busy=%s)",
  async (busy) => {
    const child = fixture();
    const result = keydCanaryLeaseAcquirer("/verified/keyd")(
      42,
      scope.state,
      nonce,
      new AbortController().signal,
    );
    const checked = busy
      ? expect(result).rejects.toThrow("diagnostic gateway still holds")
      : expect(result).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith("/verified/keyd", ["canary-lock", scope.state, nonce], {
      stdio: ["ignore", "pipe", "ignore", 42],
      env: { PATH: "/usr/bin:/bin" },
      cwd: "/",
    });
    if (!busy) child.stdout.write(`locked:${nonce}\n`);
    child.emit("close", busy ? 73 : 0, null);
    await checked;
  },
);
it("passes only the fixed service scope and inherited descriptor to the verified helper", async () => {
  const child = fixture(),
    acquire = keydServiceLeaseAcquirer("/verified/keyd", scope);
  const result = acquire(42, scope.state, nonce, new AbortController().signal);
  expect(spawn).toHaveBeenCalledWith(
    "/verified/keyd",
    ["service-lock", scope.state, scope.home, scope.ownerId, "daemon", nonce],
    {
      stdio: ["ignore", "pipe", "ignore", 42],
      env: { PATH: "/usr/bin:/bin" },
      cwd: "/",
    },
  );
  child.stdout.write(`locked:${nonce}\n`);
  child.emit("close", 0, null);
  await result;
});
it.each(["error", "pipe-error", "abort", "timeout", "overflow", "bad-reply", "signal", "busy"])(
  "drains helper closure before settling %s",
  async (kind) => {
    vi.useFakeTimers();
    const child = fixture(),
      controller = new AbortController();
    let settled = false;
    const result = keydServiceLeaseAcquirer("/verified/keyd", scope)(
      42,
      scope.state,
      nonce,
      controller.signal,
    )
      .catch((e) => e)
      .finally(() => {
        settled = true;
      });
    if (kind === "error") child.emit("error", new Error("private details"));
    if (kind === "pipe-error") child.stdout.emit("error", new Error("private details"));
    if (kind === "abort") controller.abort();
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(5000);
    if (kind === "overflow") child.stdout.write(Buffer.alloc(129));
    if (kind === "bad-reply") child.stdout.write(`locked:${"c".repeat(64)}\n`);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", kind === "busy" ? 73 : 0, kind === "signal" ? "SIGTERM" : null);
    const error = await result;
    expect(error).toBeInstanceOf(kind === "busy" ? ServiceLeaseBusy : Error);
    expect(error.message).not.toContain("private details");
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("does not spawn for a mismatched directory or pre-cancellation", async () => {
  fixture();
  const acquire = keydServiceLeaseAcquirer("/verified/keyd", scope),
    controller = new AbortController();
  await expect(acquire(42, "/wrong", nonce, controller.signal)).rejects.toThrow();
  controller.abort();
  await expect(
    keydLockAcquirer("/verified/keyd")(42, scope.state, nonce, controller.signal),
  ).rejects.toThrow();
  expect(spawn).not.toHaveBeenCalled();
});
