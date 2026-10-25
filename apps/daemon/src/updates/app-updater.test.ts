import { afterEach, expect, it, vi } from "vitest";
import {
  type AppUpdateAttempt,
  type AppUpdateRecord,
  DEFAULT_APP_UPDATES,
  type UpdateProgressLine,
} from "../../../../packages/protocol/src/app-update.ts";
import { AppUpdater, type PreparedUpdate } from "./app-updater.ts";

afterEach(() => vi.useRealTimers());
function fixture(record: AppUpdateRecord | null = null) {
  let stored = record,
    attempt: AppUpdateAttempt | null = null,
    ready = false,
    now = 1_800_000_000_000;
  const host = {
    version: "1.0.0",
    now: () => now,
    random: () => 0.5,
    read: vi.fn(async () => stored),
    save: vi.fn(async (value: AppUpdateRecord) => {
      stored = value;
    }),
    latest: vi.fn(async () => "1.1.0"),
    prepare: vi.fn(
      async (
        _version: string,
        _signal: AbortSignal,
        _progress: (line: UpdateProgressLine) => void,
      ): Promise<PreparedUpdate | undefined> => {
        ready = true;
        return undefined;
      },
    ),
    prepared: vi.fn(async () => ready),
    install: vi.fn(async () => {}),
    installWait: vi.fn((): string | null | Promise<string | null> => null),
    notes: vi.fn(async (_after: string | null, upTo: string) => [
      { version: upTo, markdown: `## Fixes\n\n- Fixed in ${upTo}.` },
    ]),
    attempts: {
      read: vi.fn(async () => attempt),
      save: vi.fn(async (value: AppUpdateAttempt | null) => {
        attempt = value;
      }),
    },
  };
  const updater = new AppUpdater(host);
  return {
    host,
    updater,
    stored: () => stored,
    advance: (ms: number) => {
      now += ms;
    },
    restart: () => new AppUpdater(host),
  };
}
it("coalesces checks and downloads across callers, saves readiness and postponement across restarts", async () => {
  const f = fixture();
  await Promise.all([f.updater.check(), f.updater.check(), f.updater.download()]);
  expect(f.host.latest).toHaveBeenCalledTimes(1);
  expect(f.host.prepare).toHaveBeenCalledTimes(1);
  expect((await f.updater.status()).phase).toBe("ready");
  await f.updater.dismiss();
  const status = await f.restart().status();
  expect(status).toMatchObject({
    availableVersion: "1.1.0",
    dismissedVersion: "1.1.0",
    phase: "ready",
  });
  expect(f.host.install).not.toHaveBeenCalled();
});
it("delays launch checks, respects the persisted six-hour deadline, and resumes when overdue", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.updater.start();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(f.host.latest).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.host.latest).toHaveBeenCalledTimes(1);
  const next = f.stored()?.nextCheckAt ?? 0;
  expect(next - f.host.now()).toBe(6 * 3_600_000);
  await f.updater.close();
  const restarted = f.restart();
  await restarted.check(false);
  expect(f.host.latest).toHaveBeenCalledTimes(1);
  f.advance(7 * 3_600_000);
  await restarted.check(false);
  expect(f.host.latest).toHaveBeenCalledTimes(2);
});
it("backs off offline failures, keeps a ready update, and lets Check now bypass the deadline", async () => {
  const f = fixture();
  await f.updater.check();
  f.host.latest.mockRejectedValue(new Error("offline private detail"));
  await f.updater.check();
  expect(await f.updater.status()).toMatchObject({ phase: "ready", availableVersion: "1.1.0" });
  expect(f.stored()?.nextCheckAt).toBe(f.host.now() + 300_000);
  await f.updater.check(false);
  expect(f.host.latest).toHaveBeenCalledTimes(2);
  await f.updater.check();
  expect(f.stored()?.nextCheckAt).toBe(f.host.now() + 600_000);
  expect(JSON.stringify(await f.updater.status())).not.toContain("private detail");
});
it("honors independent check/download preferences and manual download", async () => {
  const f = fixture();
  await f.updater.preferences({
    ...DEFAULT_APP_UPDATES,
    automaticChecks: false,
    automaticDownloads: false,
  });
  await f.updater.check(false);
  expect(f.host.latest).not.toHaveBeenCalled();
  await f.updater.check();
  expect((await f.updater.status()).availableVersion).toBe("1.1.0");
  expect(f.host.prepare).not.toHaveBeenCalled();
  await f.updater.download();
  expect((await f.updater.status()).phase).toBe("ready");
});
it("doesn't discard a pending newer version after a stale registry reply", async () => {
  const f = fixture();
  await f.updater.check();
  f.host.latest.mockResolvedValue("0.9.0");
  await f.updater.check();
  expect((await f.updater.status()).availableVersion).toBe("1.1.0");
  f.host.version = "1.1.0";
  expect((await f.restart().status()).availableVersion).toBeNull();
});
it("doesn't claim an unverified or failed download is ready", async () => {
  const f = fixture();
  f.host.prepare.mockResolvedValue(undefined);
  await f.updater.check();
  expect(await f.updater.status()).toMatchObject({
    phase: "idle",
    availableVersion: "1.1.0",
    error: "localDot 1.1.0 couldn't be downloaded, so nothing has changed.",
  });
  expect(f.host.install).not.toHaveBeenCalled();
});
it("reports one bar that never falls, then Ready to install, and keeps the step that failed", async () => {
  const f = fixture();
  const seen: unknown[] = [];
  let report: (line: UpdateProgressLine) => void = () => {};
  let finish: () => void = () => {};
  f.host.prepare.mockImplementation(async (_version, _signal, progress) => {
    report = progress;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { imagesDeferred: true };
  });
  const checking = f.updater.check();
  await vi.waitFor(() => expect(f.host.prepare).toHaveBeenCalled());
  seen.push((await f.updater.status()).progress);
  for (const line of [
    { step: "download", done: 212e6, total: 640e6 },
    { step: "download", done: 640e6, total: 640e6 },
    { step: "verify" },
    { step: "images", share: 0.5, done: 1.4e9, total: 3.1e9 },
    { step: "images", share: 0.25, done: 1.5e9, total: 3.1e9 },
  ] as const) {
    report(line);
    seen.push((await f.updater.status()).progress);
  }
  expect(seen).toEqual([
    { step: "download", value: null, detail: "Downloading" },
    { step: "download", value: 0.033, detail: "Downloading · 212 of 640 MB" },
    { step: "download", value: 0.1, detail: "Downloading · 640 of 640 MB" },
    { step: "verify", value: 0.1, detail: "Checking the download" },
    { step: "images", value: 0.55, detail: "Preparing the computer · 1.4 of 3.1 GB" },
    { step: "images", value: 0.55, detail: "Preparing the computer · 1.5 of 3.1 GB" },
  ]);
  f.host.prepared.mockResolvedValue(true);
  finish();
  await checking;
  expect((await f.updater.status()).progress).toEqual({
    step: "install",
    value: 0.95,
    detail: "Ready to install · low on disk space, so installing downloads the computer first",
  });
  const g = fixture();
  g.host.prepare.mockImplementation(async (_version, _signal, progress) => {
    progress({ step: "images", share: 0.1 });
    throw new Error("pull failed");
  });
  await g.updater.check();
  expect(await g.updater.status()).toMatchObject({
    phase: "idle",
    error: "localDot 1.1.0 couldn't be downloaded, so nothing has changed.",
    progress: { step: "images", value: 0.23 },
  });
});
it("shows the pending versions' notes, then after updating the installed one's", async () => {
  const f = fixture();
  await f.updater.check();
  expect(f.host.notes).toHaveBeenLastCalledWith("1.0.0", "1.1.0");
  expect((await f.updater.status()).notes).toEqual([
    { version: "1.1.0", markdown: "## Fixes\n\n- Fixed in 1.1.0." },
  ]);
  f.host.version = "1.1.0";
  const updated = f.restart();
  expect((await updated.status()).notes).toEqual([
    { version: "1.1.0", markdown: "## Fixes\n\n- Fixed in 1.1.0." },
  ]);
  expect(f.host.notes).toHaveBeenLastCalledWith("1.0.0", "1.1.0");
  f.host.notes.mockRejectedValue(new Error("unreadable"));
  expect((await f.restart().status()).notes).toEqual([]);
});
it("tells a rolled-back install from a finished one by the version that starts", async () => {
  const f = fixture();
  await f.updater.check();
  f.host.install.mockImplementation(() => new Promise(() => {}));
  await f.updater.install();
  expect(f.host.attempts.save).toHaveBeenLastCalledWith({ v: 1, version: "1.1.0" });
  expect((await f.updater.status()).progress).toEqual({
    step: "install",
    value: null,
    detail: "Installing localDot 1.1.0",
  });
  // The old version starts again: the new one was rolled back.
  expect(await f.restart().status()).toMatchObject({
    phase: "ready",
    error: "localDot 1.1.0 didn't start, so your previous version was restored.",
    progress: { step: "restart" },
  });
  expect(await f.restart().status()).toMatchObject({ error: null });
  await f.host.attempts.save({ v: 1, version: "1.1.0" });
  f.host.version = "1.1.0";
  expect(await f.restart().status()).toMatchObject({ error: null, progress: null });
  expect(await f.host.attempts.read()).toBeNull();
});
it("keeps a download installable after its installer fails while localDot runs", async () => {
  const f = fixture();
  await f.updater.check();
  f.host.install.mockRejectedValue(new Error("exit 1"));
  await f.updater.install();
  await vi.waitFor(async () =>
    expect(await f.updater.status()).toMatchObject({
      phase: "ready",
      error: "localDot 1.1.0 couldn't be installed, so nothing has changed.",
      progress: { step: "install" },
    }),
  );
  expect(await f.host.attempts.read()).toBeNull();
});
it("refuses installation while work is active, and shuts down independently only after explicit install", async () => {
  const f = fixture();
  await f.updater.check();
  f.host.installWait.mockReturnValue("Finish the task first.");
  await expect(f.updater.install()).rejects.toThrow("Finish");
  expect(f.host.install).not.toHaveBeenCalled();
  f.host.installWait.mockReturnValue(null);
  f.host.install.mockImplementation(() => new Promise(() => {}));
  await f.updater.install();
  expect((await f.updater.status()).phase).toBe("installing");
  await f.updater.close(); // Must not deadlock waiting for the child that is restarting us.
});
it("awaits a slow admission and starts the installer only once", async () => {
  const f = fixture();
  await f.updater.check();
  let admit: (refusal: string | null) => void = () => {};
  f.host.installWait.mockImplementation(
    () => new Promise<string | null>((resolve) => (admit = resolve)),
  );
  f.host.install.mockImplementation(() => new Promise(() => {}));
  const first = f.updater.install();
  await vi.waitFor(() => expect(f.host.installWait).toHaveBeenCalledOnce());
  await expect(f.updater.install()).rejects.toThrow("already starting");
  admit(null);
  await first;
  expect(f.host.install).toHaveBeenCalledOnce();
  expect((await f.updater.status()).phase).toBe("installing");
  await f.updater.close();
});
it("development builds perform no checks or downloads", async () => {
  const updater = new AppUpdater(null);
  updater.start();
  await updater.check();
  await updater.download();
  expect(await updater.status()).toMatchObject({ supported: false, currentVersion: "Development" });
  await updater.close();
});
