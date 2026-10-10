import { afterEach, expect, it, vi } from "vitest";
import {
  type AppUpdateRecord,
  DEFAULT_APP_UPDATES,
} from "../../../../packages/protocol/src/app-update.ts";
import { AppUpdater } from "./app-updater.ts";

afterEach(() => vi.useRealTimers());
function fixture(record: AppUpdateRecord | null = null) {
  let stored = record,
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
    prepare: vi.fn(async () => {
      ready = true;
    }),
    prepared: vi.fn(async () => ready),
    install: vi.fn(async () => {}),
    installWait: vi.fn((): string | null => null),
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
  f.host.prepare.mockResolvedValue();
  await f.updater.check();
  expect(await f.updater.status()).toMatchObject({
    phase: "idle",
    availableVersion: "1.1.0",
    error: expect.stringContaining("verified"),
  });
  expect(f.host.install).not.toHaveBeenCalled();
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
it("development builds perform no checks or downloads", async () => {
  const updater = new AppUpdater(null);
  updater.start();
  await updater.check();
  await updater.download();
  expect(await updater.status()).toMatchObject({ supported: false, currentVersion: "Development" });
  await updater.close();
});
