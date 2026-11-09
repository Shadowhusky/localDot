import { afterEach, expect, it, vi } from "vitest";
import {
  type AppUpdateAttempt,
  type AppUpdateRecord,
  DEFAULT_APP_UPDATES,
  type UpdateProgressLine,
} from "../../../../packages/protocol/src/app-update.ts";
import { AppUpdater, type InstallerState, type PreparedUpdate } from "./app-updater.ts";
import { UpdateFailure } from "./progress.ts";

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
    install: vi.fn(async (_version: string) => {}),
    installWait: vi.fn((_hold?: boolean): string | null => null),
    installed: vi.fn(async () => {}),
    installer: {
      state: null as InstallerState | null,
      read: vi.fn(async () => host.installer.state),
      reset: vi.fn(async () => {
        host.installer.state = null;
      }),
      cancel: vi.fn(),
    },
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
    { step: "download", value: 0.033, detail: "Downloading · 33% · 212 of 640 MB" },
    { step: "download", value: 0.1, detail: "Downloading · 100% · 640 of 640 MB" },
    { step: "verify", value: 0.1, detail: "Checking the download" },
    { step: "images", value: 0.55, detail: "Preparing the computer · 50% · 1.4 of 3.1 GB" },
    { step: "images", value: 0.55, detail: "Preparing the computer · 25% · 1.5 of 3.1 GB" },
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
  await vi.waitFor(() => expect(f.host.install).toHaveBeenCalled());
  expect(f.host.attempts.save).toHaveBeenLastCalledWith({ v: 1, version: "1.1.0" });
  expect((await f.updater.status()).progress).toEqual({
    step: "install",
    value: 0.95,
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
  await vi.waitFor(async () => expect((await f.updater.status()).phase).toBe("installing"));
  await f.updater.close(); // Must not deadlock waiting for the child that is restarting us.
});
it("Update now shows work at once, then checks, downloads and installs in one go", async () => {
  const f = fixture();
  f.host.install.mockImplementation(() => new Promise(() => {}));
  await f.updater.update();
  expect(await f.updater.status()).toMatchObject({ phase: "checking", updating: true });
  await vi.waitFor(() => expect(f.host.install).toHaveBeenCalledWith("1.1.0"));
  expect(f.host.latest).toHaveBeenCalledTimes(1);
  expect(f.host.prepare).toHaveBeenCalledTimes(1);
  expect(await f.updater.status()).toMatchObject({
    phase: "installing",
    updating: true,
    progress: { step: "install", detail: "Installing localDot 1.1.0" },
  });
});
it("a prepared version a newer release has overtaken is replaced, not installed", async () => {
  const f = fixture();
  await f.updater.check();
  f.host.install.mockImplementation(() => new Promise(() => {}));
  f.host.latest.mockResolvedValue("1.2.0");
  let fetched = false;
  f.host.prepared.mockImplementation(async () => fetched);
  f.host.prepare.mockImplementation(async () => {
    fetched = true;
    return undefined;
  });
  await f.updater.update();
  await vi.waitFor(() => expect(f.host.install).toHaveBeenCalled());
  expect(f.host.prepare).toHaveBeenLastCalledWith("1.2.0", expect.anything(), expect.anything());
  expect(f.host.install).toHaveBeenCalledWith("1.2.0");
});
it("a release published while downloading is followed, not reported as a failure", async () => {
  const f = fixture();
  f.host.install.mockImplementation(() => new Promise(() => {}));
  f.host.prepare.mockImplementationOnce(async () => {
    f.host.latest.mockResolvedValue("1.2.0");
    throw new UpdateFailure("channel");
  });
  let fetched = false;
  f.host.prepare.mockImplementation(async () => {
    fetched = true;
    return undefined;
  });
  f.host.prepared.mockImplementation(async () => fetched);
  await f.updater.update();
  await vi.waitFor(() => expect(f.host.install).toHaveBeenCalledWith("1.2.0"));
  expect((await f.updater.status()).error).toBeNull();
});
it("a second click or device joins the update, and only one install starts", async () => {
  const f = fixture();
  f.host.install.mockImplementation(() => new Promise(() => {}));
  await Promise.all([f.updater.update(), f.updater.update()]);
  await f.updater.update();
  await vi.waitFor(() => expect(f.host.install).toHaveBeenCalled());
  await f.updater.update();
  await f.updater.install();
  expect(f.host.install).toHaveBeenCalledTimes(1);
  expect(f.host.latest).toHaveBeenCalledTimes(1);
});
it("says why a working task holds Update now back, and still prepares the download", async () => {
  const f = fixture();
  f.host.installWait.mockReturnValue("Finish or stop the task before updating localDot.");
  await expect(f.updater.update()).rejects.toThrow("Finish or stop the task");
  await vi.waitFor(async () => expect((await f.updater.status()).phase).toBe("ready"));
  expect(f.host.install).not.toHaveBeenCalled();
  expect((await f.updater.status()).updating).toBe(false);
  expect(f.host.installWait).toHaveBeenCalledWith(false);
});
it("says so when a task starts during the download, and leaves the update ready", async () => {
  const f = fixture();
  let downloaded: () => void = () => {};
  f.host.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        downloaded = () => resolve(undefined);
      }),
  );
  await f.updater.update();
  await vi.waitFor(() => expect(f.host.prepare).toHaveBeenCalled());
  f.host.prepared.mockResolvedValue(true);
  f.host.installWait.mockImplementation((hold) =>
    hold === false ? null : "Finish or stop the task before updating localDot.",
  );
  downloaded();
  await vi.waitFor(async () =>
    expect(await f.updater.status()).toMatchObject({
      phase: "ready",
      updating: false,
      error: "Finish or stop the task before updating localDot.",
      progress: null,
    }),
  );
  expect(f.host.install).not.toHaveBeenCalled();
});
it.each([
  ["disk", "There isn't enough free disk space."],
  ["network", "Check your connection and try again."],
  ["stalled", "The download stopped moving."],
  ["docker", "Docker isn't running."],
  ["verify", "The download didn't match its signed release."],
] as const)("says what stopped a download: %s", async (problem, words) => {
  const f = fixture();
  f.host.prepare.mockRejectedValue(new UpdateFailure(problem));
  await f.updater.check();
  const { error, phase } = await f.updater.status();
  expect(phase).toBe("idle");
  expect(error).toContain("couldn't be downloaded, so nothing has changed.");
  expect(error).toContain(words);
});
it("says what stopped the installer, from what it recorded, and offers the download again", async () => {
  const f = fixture();
  await f.updater.check();
  f.host.install.mockImplementation(async () => {
    f.host.installer.state = {
      stage: "failed",
      problem: "docker",
      restored: false,
      running: false,
    };
    throw new Error("exit 1");
  });
  await f.updater.update();
  await vi.waitFor(async () =>
    expect(await f.updater.status()).toMatchObject({
      phase: "ready",
      updating: false,
      error: expect.stringContaining("Docker isn't running."),
      progress: { step: "install" },
    }),
  );
  expect(f.host.attempts.save).toHaveBeenLastCalledWith(null);
});
it("holds localDot only once it is about to install, not for the download before it", async () => {
  const f = fixture();
  f.host.install.mockImplementation(() => new Promise(() => {}));
  await f.updater.update();
  expect(f.host.installWait.mock.calls).toEqual([[false]]);
  await vi.waitFor(() => expect(f.host.install).toHaveBeenCalled());
  expect(f.host.installWait.mock.calls).toEqual([[false], []]);
});
it("follows the installer through its stages, on one bar that never falls", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.updater.check();
  f.host.install.mockImplementation(() => new Promise(() => {}));
  await f.updater.update();
  await vi.advanceTimersByTimeAsync(0);
  const seen: unknown[] = [];
  for (const stage of ["prepare", "verify", "images", "stop", "start"] as const) {
    f.host.installer.state = { stage, restored: false, running: true };
    await vi.advanceTimersByTimeAsync(1000);
    seen.push((await f.updater.status()).progress);
  }
  expect(seen).toEqual([
    { step: "install", value: 0.95, detail: "Getting ready to install localDot 1.1.0" },
    { step: "install", value: 0.96, detail: "Checking the download once more" },
    { step: "install", value: 0.96, detail: "Downloading the computer" },
    { step: "restart", value: 0.97, detail: "Restarting localDot" },
    { step: "restart", value: 0.98, detail: "Starting localDot 1.1.0" },
  ]);
  await f.updater.close();
});
it("stops an installer stuck before the swap and says so, leaving the old version", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.updater.check();
  let exit: (error: Error) => void = () => {};
  f.host.install.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        exit = reject;
      }),
  );
  f.host.installer.cancel.mockImplementation(() => exit(new Error("killed")));
  await f.updater.update();
  await vi.advanceTimersByTimeAsync(0);
  f.host.installer.state = { stage: "verify", restored: false, running: true };
  await vi.advanceTimersByTimeAsync(1000);
  f.advance(21 * 60_000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.host.installer.cancel).toHaveBeenCalled();
  expect(await f.updater.status()).toMatchObject({
    phase: "ready",
    error: expect.stringContaining("stopped responding"),
    progress: { step: "install" },
  });
  await f.updater.close();
});
it("never cancels an installer that has begun the swap", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.updater.check();
  f.host.install.mockImplementation(() => new Promise(() => {}));
  await f.updater.update();
  await vi.advanceTimersByTimeAsync(0);
  f.host.installer.state = { stage: "start", restored: false, running: true };
  await vi.advanceTimersByTimeAsync(1000);
  f.advance(60 * 60_000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.host.installer.cancel).not.toHaveBeenCalled();
  await f.updater.close();
});
it("says so when an installer finished yet localDot didn't restart, rather than spin", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.updater.check();
  await f.updater.update();
  await vi.advanceTimersByTimeAsync(61_000);
  expect(await f.updater.status()).toMatchObject({
    phase: "ready",
    error: expect.stringContaining("didn't restart"),
  });
  await f.updater.close();
});
it("the new version keeps saying it is installing until the installer's checks pass", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.updater.check();
  await f.host.attempts.save({ v: 1, version: "1.1.0" });
  f.host.version = "1.1.0";
  f.host.installer.state = { stage: "check", restored: false, running: true };
  const updated = f.restart();
  expect(await updated.status()).toMatchObject({
    phase: "installing",
    updating: true,
    currentVersion: "1.1.0",
    progress: { step: "restart", detail: "Checking localDot 1.1.0" },
  });
  expect(await f.host.attempts.read()).not.toBeNull();
  f.host.installer.state = { stage: "done", restored: false, running: false };
  await vi.advanceTimersByTimeAsync(1000);
  expect(await updated.status()).toMatchObject({
    phase: "idle",
    updating: false,
    error: null,
    progress: null,
  });
  expect(await f.host.attempts.read()).toBeNull();
  expect(f.host.installed).toHaveBeenCalled();
  await updated.close();
});
it("tells the old version the checks failed after the new one answered", async () => {
  const f = fixture();
  await f.updater.check();
  await f.host.attempts.save({ v: 1, version: "1.1.0" });
  f.host.installer.state = { stage: "failed", problem: "checks", restored: true, running: false };
  expect(await f.restart().status()).toMatchObject({
    phase: "ready",
    updating: false,
    error: "localDot 1.1.0 started but failed its checks, so your previous version was restored.",
    progress: { step: "restart" },
  });
  expect(await f.host.attempts.read()).toBeNull();
  expect(f.host.installed).not.toHaveBeenCalled();
});
it("a daemon that restarted while its installer worked joins it, and reports nothing false", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.updater.check();
  await f.host.attempts.save({ v: 1, version: "1.1.0" });
  f.host.installer.state = { stage: "verify", restored: false, running: true };
  const again = f.restart();
  expect(await again.status()).toMatchObject({
    phase: "installing",
    error: null,
    progress: { step: "install" },
  });
  f.host.installer.state = { stage: "failed", problem: "disk", restored: false, running: false };
  await vi.advanceTimersByTimeAsync(1000);
  expect(await again.status()).toMatchObject({
    phase: "ready",
    error: expect.stringContaining("There isn't enough free disk space."),
  });
  await again.close();
});
it("says an interrupted update was interrupted, not that the version didn't start", async () => {
  const f = fixture();
  await f.updater.check();
  await f.host.attempts.save({ v: 1, version: "1.1.0" });
  f.host.installer.state = {
    stage: "failed",
    problem: "interrupted",
    restored: true,
    running: false,
  };
  expect((await f.restart().status()).error).toBe(
    "The update to localDot 1.1.0 was interrupted, so your previous version was restored.",
  );
});
it("doesn't wait forever on an installer record nothing is behind any more", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.host.attempts.save({ v: 1, version: "1.1.0" });
  f.host.version = "1.1.0";
  f.host.installer.state = { stage: "start", restored: false, running: true };
  const updated = f.restart();
  expect(await updated.status()).toMatchObject({ phase: "installing" });
  await vi.advanceTimersByTimeAsync(1000);
  f.advance(21 * 60_000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await updated.status()).toMatchObject({ phase: "idle", updating: false, error: null });
  await updated.close();
});
it("says an installer that died before touching anything changed nothing", async () => {
  const f = fixture();
  await f.updater.check();
  await f.host.attempts.save({ v: 1, version: "1.1.0" });
  f.host.installer.state = { stage: "verify", restored: false, running: false };
  expect(await f.restart().status()).toMatchObject({
    phase: "ready",
    error: "The update to localDot 1.1.0 was interrupted, so nothing has changed.",
    progress: { step: "install" },
  });
});
it("development builds perform no checks or downloads", async () => {
  const updater = new AppUpdater(null);
  updater.start();
  await updater.check();
  await updater.download();
  expect(await updater.status()).toMatchObject({ supported: false, currentVersion: "Development" });
  await updater.close();
});
it("says why a copy can't update itself", async () => {
  expect((await new AppUpdater(null, "source-checkout").status()).unsupported).toBe(
    "source-checkout",
  );
  expect((await new AppUpdater(null).status()).unsupported).toBeNull();
  await expect(new AppUpdater(null, "source-checkout").update()).rejects.toThrow();
});
