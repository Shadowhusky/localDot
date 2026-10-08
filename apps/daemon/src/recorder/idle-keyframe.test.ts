import { rmSync as cleanupDir, mkdtempSync as makeTemp, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthFrame } from "@localdot/stage/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRecorder as ProductionSessionRecorder, TICK_MS } from "./session-recorder.ts";
import { FakeFeed } from "./testing/fake-feed.ts";

const o = { widthMbs: 4, heightMbs: 4, keyEvery: 15 };
const at = (i: number) => 1_000_000 + i * 16_667;
const HOUR = 3_600_000_000;
const TICK = TICK_MS * 1000;

function bytesIn(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true }))
    if (e.isFile()) n += statSync(join(e.parentPath, e.name)).size;
  return n;
}

describe("a still screen (I2)", () => {
  for (const latency of [80_000, 900_000]) {
    it(`asks once per still stretch even when every request is answered after ${latency / 1000} ms, and the answers add no activity`, async () => {
      const dir = join(mkdtempSync(join(tmpdir(), "local dot's still-")), "recording");
      const feed = new FakeFeed();
      const rec = new SessionRecorder({
        sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
        dir,
        feed: (h) => feed.attach(h),
        toSessionT: (us) => us,
        freeBytes: () => 1024 ** 4,
      });
      await rec.start();
      for (let i = 0; i < 60; i++) feed.frame(synthFrame(o, i), at(i), 64, 64);
      await rec.drain();
      const key = synthFrame(o, 60);
      expect(key.key).toBe(true);
      const requests0 = feed.keyRequests.length;
      const activity0 = structuredClone(rec.manifest.activity);
      const bytes0 = bytesIn(dir);
      // One still hour. The service ticks every 100 ms; Selkies answers every request with an IDR
      // after `latency`, and the feed's START_VIDEO watchdog may cost one more IDR every 30 s.
      const start = at(59);
      let seen = requests0;
      const due: number[] = [];
      let idrs = 0;
      for (let now = start + TICK; now <= start + HOUR; now += TICK) {
        while (due.length > 0 && (due[0] as number) <= now) {
          feed.frame(key, due.shift() as number, 64, 64);
          idrs++;
        }
        if ((now - start) % 30_000_000 === 0) {
          feed.frame(key, now, 64, 64);
          idrs++;
        }
        await rec.drain();
        await rec.tick(now);
        for (; seen < feed.keyRequests.length; seen++) due.push(now + latency);
      }
      await rec.drain();
      expect(feed.keyRequests.length - requests0).toBe(1);
      expect(idrs).toBeLessThanOrEqual(1 + HOUR / 30_000_000);
      expect(rec.manifest.activity).toEqual(activity0);
      // Bytes per idle hour: the IDRs themselves, each its own fragment, and nothing more.
      expect(bytesIn(dir) - bytes0).toBeLessThan(idrs * (key.data.length + 1024));
      // The screen changes: a delta opens a new span, and the next still stretch asks once more.
      const changed = start + HOUR + 50_000;
      feed.frame(synthFrame(o, 61), changed, 64, 64);
      await rec.drain();
      expect(rec.manifest.activity.at(-1)).toEqual({ from: changed, to: changed });
      for (let now = changed + TICK; now <= changed + 60_000_000; now += TICK) await rec.tick(now);
      expect(feed.keyRequests.length - requests0).toBe(2);
      await rec.stop(changed + 60_000_000);
    }, 60_000);
  }
});

const ownedRoots: string[] = [];
const ownedRecorders: ProductionSessionRecorder[] = [];
function mkdtempSync(prefix: string): string {
  const dir = makeTemp(prefix);
  ownedRoots.push(dir);
  return dir;
}
class SessionRecorder extends ProductionSessionRecorder {
  constructor(...args: ConstructorParameters<typeof ProductionSessionRecorder>) {
    super(...args);
    ownedRecorders.push(this);
  }
}
afterEach(async () => {
  for (const rec of ownedRecorders.splice(0)) await rec.stop(8_000_000_000);
  for (const dir of ownedRoots.splice(0)) cleanupRoot(dir);
});

function cleanupRoot(dir: string): void {
  cleanupDir(dir, { recursive: true, force: true });
}
