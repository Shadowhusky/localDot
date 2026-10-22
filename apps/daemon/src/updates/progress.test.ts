import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import type { UpdateProgressLine } from "../../../../packages/protocol/src/app-update.ts";
import { progressAfter, readUpdateProgress, runPreparation } from "./progress.ts";

async function* chunks(...parts: (string | Buffer)[]) {
  for (const part of parts) yield part;
}

it("reads lines split across chunks and skips malformed, unknown and overlong ones", async () => {
  const seen: UpdateProgressLine[] = [];
  await readUpdateProgress(
    chunks(
      '{"step":"downlo',
      'ad","done":1,"total":2}\nnot json\n{"step":"install"}\n',
      `{"step":"verify","pad":"${"x".repeat(2000)}"}\n`,
      Buffer.from([0xff, 0x0a]),
      '{"step":"images","share":0.5}',
    ),
    (line) => seen.push(line),
  );
  expect(seen).toEqual([
    { step: "download", done: 1, total: 2 },
    { step: "images", share: 0.5 },
  ]);
});

it("maps steps onto one bar that never falls or loses its length", () => {
  let progress = progressAfter(null, { step: "download" });
  expect(progress).toEqual({ step: "download", value: null, detail: "Downloading" });
  progress = progressAfter(progress, { step: "download", done: 50e6, total: 100e6 });
  expect(progress).toEqual({ step: "download", value: 0.05, detail: "Downloading · 50 of 100 MB" });
  progress = progressAfter(progress, { step: "download" });
  expect(progress.value).toBe(0.05);
  progress = progressAfter(progress, { step: "images", share: 1, done: 2.5e9, total: 2.5e9 });
  expect(progress).toEqual({
    step: "images",
    value: 0.95,
    detail: "Preparing the computer · 2.5 of 2.5 GB",
  });
  expect(progressAfter(progress, { step: "verify" }).value).toBe(0.95);
});

function child() {
  const progress = new PassThrough();
  const process = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, progress],
    kill: vi.fn(),
  });
  return { process, progress };
}

it("passes a progress channel on descriptor 3 and resolves only on a clean exit", async () => {
  const { process: proc, progress } = child();
  const start = vi.fn(() => proc) as unknown as typeof spawn;
  const lines: UpdateProgressLine[] = [];
  const run = runPreparation(
    start,
    { command: "/node", args: ["prepare"], env: { HOME: "/home" }, output: 9, timeoutMs: 60_000 },
    new AbortController().signal,
    (line) => lines.push(line),
  );
  expect(vi.mocked(start).mock.calls[0]?.[2]).toMatchObject({
    env: { HOME: "/home", LOCALDOT_PROGRESS_FD: "3" },
    stdio: ["ignore", 9, 9, "pipe"],
  });
  // Far more than the old 8 KB output buffer, as a long download writes.
  for (let i = 0; i < 2000; i++) progress.write(`{"step":"download","done":${i},"total":2000}\n`);
  progress.end();
  proc.emit("exit", 0);
  await run;
  expect(lines).toHaveLength(2000);

  const failed = child();
  const failing = runPreparation(
    vi.fn(() => failed.process) as unknown as typeof spawn,
    { command: "/node", args: [], env: {}, output: "ignore", timeoutMs: 60_000 },
    new AbortController().signal,
    () => {},
  );
  failed.process.emit("exit", 1);
  await expect(failing).rejects.toThrow("failed");
});

it("ends a cancelled preparation and does not wait for a channel a grandchild holds", async () => {
  const { process: proc } = child();
  const controller = new AbortController();
  const run = runPreparation(
    vi.fn(() => proc) as unknown as typeof spawn,
    { command: "/node", args: [], env: {}, output: "ignore", timeoutMs: 60_000 },
    controller.signal,
    () => {},
  );
  controller.abort();
  expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  proc.emit("exit", 0);
  await expect(run).rejects.toThrow();
});
