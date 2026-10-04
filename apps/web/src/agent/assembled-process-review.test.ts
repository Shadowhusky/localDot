import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { TestInfo } from "@playwright/test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assembledProcess } from "../../e2e/fixtures/assembled-process.ts";

const seam = vi.hoisted(() => ({
  spawn: vi.fn(),
  root: `${process.env.LOCALDOT_TASK14_REVIEW_DIR ?? "/private/tmp/localdot-m4-ui-task14-review/full"}/inert-process-fixtures`,
  failStart: false,
  failStdout: false,
}));
vi.mock("node:child_process", () => ({ spawn: seam.spawn }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (seam.failStart && String(args[0]).endsWith("/start.json"))
        throw new Error("inert startup-artifact failure");
      if (seam.failStdout && String(args[0]).endsWith("/stdout.log"))
        throw new Error("inert stdout-artifact failure");
      return fs.writeFileSync(...args);
    },
    mkdtempSync: (prefix: string) =>
      fs.mkdtempSync(prefix === "/tmp/ld-ui14-" ? join(seam.root, "home-") : prefix),
  };
});
mkdirSync(seam.root, { recursive: true });
function fixture() {
  const artifacts = mkdtempSync(join(seam.root, "artifacts-"));
  const child = Object.assign(new EventEmitter(), {
    pid: 900001,
    connected: true,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    send: vi.fn<
      (message: { id: number; kind: string }, callback: (error: Error | null) => void) => void
    >(),
    kill: vi.fn<(signal: string) => boolean>(),
  });
  const finish = (code: number) => {
    child.connected = false;
    child.emit("close", code);
  };
  child.kill.mockImplementation(() => {
    finish(1);
    return true;
  });
  child.send.mockImplementation((message, callback) => {
    callback(null);
    queueMicrotask(() => {
      child.emit("message", { id: message.id, ok: true, value: { clean: true } });
      finish(0);
    });
  });
  seam.spawn.mockImplementation(() => {
    queueMicrotask(() =>
      child.emit("message", {
        kind: "ready",
        url: "http://127.0.0.1:1/#token=inert",
        images: { brain: "inert", gate: "inert", desktop: "inert" },
        pid: child.pid,
      }),
    );
    return child;
  });
  const info = { outputPath: (name: string) => join(artifacts, name) } as TestInfo;
  return { child, finish, open: () => assembledProcess(info) };
}
beforeEach(() => {
  vi.clearAllMocks();
  seam.failStart = false;
  seam.failStdout = false;
  for (const key of [
    "LOCALDOT_BRAIN_IMAGE",
    "LOCALDOT_GATE_IMAGE",
    "LOCALDOT_DESKTOP_IMAGE",
    "LOCALDOT_KEYD_BIN",
  ])
    vi.stubEnv(key, "inert-fixture");
  vi.stubEnv("LOCALDOT_ASSEMBLED_TESTS", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("positive control: clean helper retirement waits for close and records no forced kill", async () => {
  const f = fixture();
  const runtime = await f.open();
  await runtime.close();
  expect(f.child.connected).toBe(false);
  expect(f.child.kill).not.toHaveBeenCalled();
  await runtime.close();
  expect(f.child.send).toHaveBeenCalledOnce();
});

it("concurrent close cannot report completion while the owned worker is still connected", async () => {
  const f = fixture();
  const runtime = await f.open();
  let request: { id: number; kind: string } | undefined;
  f.child.send.mockImplementation((message, callback) => {
    request = message;
    callback(null);
  });
  const first = runtime.close();
  let secondCompleted = false;
  const second = runtime.close().then(() => {
    secondCompleted = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  try {
    expect(f.child.connected).toBe(true);
    expect
      .soft(secondCompleted, "every caller must join the in-flight retirement barrier")
      .toBe(false);
  } finally {
    f.child.emit("message", { id: request?.id, ok: true, value: { clean: true } });
    f.finish(0);
    await Promise.all([first, second]);
  }
});

it("a later close retains an earlier cleanup rejection instead of reporting success", async () => {
  const f = fixture();
  const runtime = await f.open();
  f.child.send.mockImplementation((message, callback) => {
    callback(null);
    queueMicrotask(() =>
      f.child.emit("message", { id: message.id, ok: false, error: "inert cleanup failure" }),
    );
  });
  await expect(runtime.close()).rejects.toThrow("Owned runtime cleanup failed");
  await expect(
    runtime.close(),
    "uncertain retirement must remain failed for later owners",
  ).rejects.toThrow("Owned runtime cleanup failed");
});

it("explicit opt-out refuses before allocating a child", async () => {
  const f = fixture();
  vi.stubEnv("LOCALDOT_ASSEMBLED_TESTS", "0");
  await expect(f.open()).rejects.toThrow("Explicit Docker acceptance opt-in required");
  expect(seam.spawn).not.toHaveBeenCalled();
});

it("construction artifact failure unwinds the acquired worker before rejecting", async () => {
  const f = fixture();
  seam.failStart = true;
  try {
    await expect(f.open()).rejects.toThrow("inert startup-artifact failure");
    expect(
      f.child.send,
      "post-ready artifact failure must request owned worker retirement",
    ).toHaveBeenCalledOnce();
  } finally {
    f.finish(1);
  }
});

it("a log capture failure cannot escape the close listener and strand retirement", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let escaped: unknown;
  let outcome = "pending";
  try {
    const runtime = await f.open();
    seam.failStdout = true;
    f.child.send.mockImplementation((message, callback) => {
      callback(null);
      queueMicrotask(() => {
        f.child.emit("message", { id: message.id, ok: true, value: { clean: true } });
        try {
          f.finish(0);
        } catch (error) {
          escaped = error;
        }
      });
    });
    void runtime.close().then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(escaped, "close listener must contain capture failures").toBeUndefined();
    expect(outcome, "closed child with failed capture must reject, never strand or succeed").toBe(
      "rejected",
    );
  } finally {
    seam.failStdout = false;
    f.finish(1);
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
