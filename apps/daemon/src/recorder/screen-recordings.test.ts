import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../event-log.ts";
import { RecordingBudget } from "./budget.ts";
import { ScreenRecordings } from "./screen-recordings.ts";
import { FakeFeed } from "./testing/fake-feed.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture(enabled = true, maxBytes?: number) {
  const home = mkdtempSync(join(tmpdir(), "two-screen-recordings-"));
  const clock = { now: 0, nowMicros: () => clock.now };
  const log = new EventLog(home, clock),
    id = log.createSession("two screens");
  const desktop = new FakeFeed(),
    browser = new FakeFeed();
  const finished = vi.fn(async () => {});
  const cells = { get: () => undefined, endpoints: () => undefined };
  const recordings = new ScreenRecordings(
    {
      home,
      clock,
      eventLog: log,
      cells,
      enabled,
      freeBytes: () => 1024 ** 4,
      startTimeoutMs: 10,
      feedFor: (_cell, handlers) => desktop.attach(handlers),
      onFinished: finished,
    },
    { cells, feedFor: (_cell, handlers) => browser.attach(handlers) },
    maxBytes,
  );
  const desktopCell = ulid(),
    browserCell = ulid();
  const scope = { signal: new AbortController().signal, check: () => {} };
  const selection = (screen: "desktop" | "browser") => ({
    screen,
    cellId: screen === "desktop" ? desktopCell : browserCell,
    geometry: { w: 64, h: 64, scale: 1 as const },
    revision: 1,
  });
  const frame = (feed: FakeFeed, t: number, index = 0) =>
    feed.frame(synthFrame({ widthMbs: 4, heightMbs: 4, keyEvery: 1 }, index), t, 64, 64);
  async function attach(screen: "desktop" | "browser", t = clock.now) {
    const attaching = recordings.attach(id, selection(screen), scope);
    frame(screen === "desktop" ? desktop : browser, t);
    await attaching;
  }
  const path = (screen: "desktop" | "browser") =>
    join(
      home,
      "sessions",
      id,
      screen === "desktop" ? "recording" : "recording-browser",
      "video.mp4",
    );
  cleanups.push(async () => {
    await recordings.stopAll();
    log.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    clock,
    log,
    id,
    desktop,
    browser,
    recordings,
    scope,
    selection,
    frame,
    attach,
    path,
    finished,
  };
}
async function times(file: string) {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("No recorded track");
    const result: number[] = [];
    for await (const packet of new EncodedPacketSink(track).packets())
      result.push(packet.microsecondTimestamp);
    return result;
  } finally {
    input.dispose();
  }
}

describe("unattended two-screen recording", () => {
  it("keeps the session live when only the browser recording remains active", async () => {
    const f = fixture();
    await f.attach("desktop");
    await f.attach("browser");
    await f.recordings.desktop.stop(f.id);
    expect(f.recordings.isLive(f.id)).toBe(true);
    expect(f.recordings.info(f.id)?.live).toBe(false);
    expect(f.recordings.info(f.id, "browser")?.live).toBe(true);
    await f.recordings.stop(f.id);
    expect(f.recordings.isLive(f.id)).toBe(false);
    expect(f.finished).toHaveBeenCalledTimes(1);
  });

  it("attaches actual muxed tracks separately on the same clock and finalizes once", async () => {
    const f = fixture();
    await f.attach("desktop", 0);
    await f.attach("browser", 50_000);
    f.frame(f.desktop, 100_000, 1);
    f.frame(f.browser, 150_000, 1);
    f.clock.now = 200_000;
    await Promise.all([f.recordings.stop(f.id), f.recordings.stop(f.id)]);
    expect(f.finished).toHaveBeenCalledTimes(1);
    expect(existsSync(f.path("desktop"))).toBe(true);
    expect(existsSync(f.path("browser"))).toBe(true);
    expect(await times(f.path("desktop"))).toContain(100_000);
    expect(await times(f.path("browser"))).toContain(150_000);
    expect(f.recordings.desktop.info(f.id)?.manifest.width).toBe(64);
    expect(f.recordings.browser.info(f.id)?.manifest.width).toBe(64);
  });

  it("keeps both privacy gates closed after takeover.end until screen authority resumes", async () => {
    const f = fixture();
    await f.attach("desktop");
    await f.attach("browser");
    f.clock.now = 100_000;
    await f.recordings.fence(f.id);
    f.frame(f.desktop, 150_000, 1);
    f.frame(f.browser, 150_000, 1);
    f.clock.now = 200_000;
    f.log.append(f.id, {
      type: "takeover.end",
      agent: "main",
      data: { requestId: ulid(), by: "user" },
    });
    f.frame(f.desktop, 250_000, 2);
    f.frame(f.browser, 250_000, 2);
    f.clock.now = 300_000;
    await f.attach("browser", 300_000);
    f.frame(f.desktop, 350_000, 3);
    f.frame(f.browser, 350_000, 3);
    f.clock.now = 400_000;
    await f.recordings.stop(f.id);
    for (const screen of ["desktop", "browser"] as const) {
      const recorded = await times(f.path(screen));
      expect(recorded.some((t) => t >= 100_000 && t < 300_000)).toBe(false);
      expect(recorded).toContain(350_000);
    }
  });

  it("a concurrent fence invalidates a pending attachment and never reopens recording", async () => {
    const f = fixture();
    const attaching = f.recordings
      .attach(f.id, f.selection("browser"), f.scope)
      .catch(() => "fenced");
    f.clock.now = 10;
    await f.recordings.fence(f.id);
    f.frame(f.browser, 20);
    expect(await attaching).toBe("fenced");
    await f.recordings.stop(f.id);
    expect(existsSync(f.path("browser"))).toBe(false);
  });

  it("refuses an unready, stopped, mismatched-owner or mismatched-geometry attachment", async () => {
    const f = fixture();
    expect(await f.recordings.desktop.attach("first", f.id)).toBe("unavailable");
    expect(await f.recordings.desktop.attach("other", f.id)).toBe("unavailable");
    f.frame(f.desktop, 0);
    expect(await f.recordings.desktop.attach("first", f.id)).toBe("ready");
    await expect(
      f.recordings.attach(
        f.id,
        { ...f.selection("desktop"), cellId: "first", geometry: { w: 128, h: 64, scale: 1 } },
        f.scope,
      ),
    ).rejects.toThrow();
    await f.recordings.stop(f.id);
    const before = readFileSync(f.path("desktop"));
    expect(await f.recordings.desktop.attach("first", f.id)).toBe("unavailable");
    expect(readFileSync(f.path("desktop"))).toEqual(before);
  });

  it("treats disabled recording as an explicit attachment outcome without starting either feed", async () => {
    const f = fixture(false);
    await f.recordings.attach(f.id, f.selection("desktop"), f.scope);
    await f.recordings.attach(f.id, f.selection("browser"), f.scope);
    expect(f.desktop.started || f.browser.started).toBe(false);
    expect(f.recordings.browser.info(f.id)?.manifest.state).toBe("none");
  });

  it("one track exhausting the session allowance stops the other track too", async () => {
    const f = fixture(true, 1);
    await f.attach("desktop");
    await f.attach("browser");
    f.frame(f.desktop, 100_000, 1);
    f.frame(f.desktop, 200_000, 2);
    f.clock.now = 250_000;
    await f.recordings.desktop.hold(f.id);
    f.frame(f.browser, 300_000, 1);
    f.clock.now = 400_000;
    await f.recordings.browser.hold(f.id);
    expect(
      f.recordings.desktop.info(f.id)?.manifest.gaps.some((g) => g.reason === "size-cap"),
    ).toBe(true);
    expect(
      f.recordings.browser.info(f.id)?.manifest.gaps.some((g) => g.reason === "size-cap"),
    ).toBe(true);
  });
});

describe("shared recording budget", () => {
  it("retains both owners and cannot reset usage by reacquiring an owner", () => {
    const budget = new RecordingBudget(100),
      desktop = budget.owner("desktop"),
      browser = budget.owner("browser");
    expect(desktop.commit(60)).toBe(false);
    expect(browser.commit(40)).toBe(true);
    expect(desktop.exhausted()).toBe(true);
    expect(budget.bytes).toBe(100);
    expect(() => budget.owner("desktop").commit(1)).toThrow();
    expect(budget.bytes).toBe(100);
  });
});
