import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../event-log.ts";
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

describe("review: screen privacy before journal publication", () => {
  it("drops queued and late user-era frames from both actual muxed tracks without needing a takeover event", async () => {
    const f = fixture();
    await f.attach("desktop");
    await f.attach("browser");
    f.clock.now = 100000;
    f.frame(f.desktop, 100000, 1);
    f.frame(f.browser, 100000, 1);
    const drain = f.recordings.fence(f.id);
    f.frame(f.desktop, 150000, 2);
    f.frame(f.browser, 150000, 2);
    await drain;
    f.clock.now = 200000;
    await f.attach("browser", 200000);
    f.frame(f.desktop, 150000, 3);
    f.frame(f.browser, 150000, 3);
    f.frame(f.desktop, 300000, 4);
    f.frame(f.browser, 300000, 4);
    f.clock.now = 400000;
    await f.recordings.stop(f.id);
    for (const track of ["desktop", "browser"] as const) {
      const packets = await times(f.path(track));
      expect(packets).toContain(0);
      expect(packets).not.toContain(100000);
      expect(packets).not.toContain(150000);
      expect(packets).toContain(300000);
    }
  });
  it("positive: both unattended tracks retain their own exact frame times before any fence", async () => {
    const f = fixture();
    await f.attach("desktop");
    await f.attach("browser", 50000);
    f.frame(f.desktop, 100000, 1);
    f.frame(f.browser, 150000, 1);
    f.clock.now = 200000;
    await f.recordings.stop(f.id);
    expect(await times(f.path("desktop"))).toEqual([0, 100000]);
    expect(await times(f.path("browser"))).toEqual([50000, 150000]);
    expect(f.finished).toHaveBeenCalledTimes(1);
  });
});
