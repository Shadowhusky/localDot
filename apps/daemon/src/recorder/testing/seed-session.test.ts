import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferSource, EncodedPacketSink, Input, MP4 } from "mediabunny";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../../event-log.ts";
import { readManifest } from "../manifest.ts";
import { seedSession } from "./seed-session.ts";

const roots: string[] = [];
function home() {
  const root = mkdtempSync(join(tmpdir(), "localdot-seed-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("seeded replay sessions", () => {
  it("can leave visible idle gaps without changing the default seed cadence", async () => {
    const root = home();
    const seed = await seedSession({ home: root, minutes: 0.5, stepsPerMinute: 6 });
    expect(seed.steps.map((step) => step.startMs)).toEqual([0, 10_000, 20_000]);
    expect(seed.steps.map((step) => step.endMs)).toEqual([2500, 12_500, 22_500]);
    await expect(seedSession({ home: root, minutes: 1, stepsPerMinute: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(seedSession({ home: root, minutes: 1, stepsPerMinute: 121 })).rejects.toThrow(
      RangeError,
    );
  });
  it("writes replayable events, screenshots, a seekable complete video and a seed receipt", async () => {
    const dir = home(),
      seed = await seedSession({ home: dir, minutes: 0.25 });
    const log = new EventLog(dir);
    try {
      const events = log.read(seed.sessionId);
      expect(events.at(0)?.type).toBe("session.start");
      expect(events.at(-1)?.type).toBe("session.end");
      expect(seed.steps).toHaveLength(3);
      expect(events.filter((e) => e.type === "observe")).toHaveLength(3);
    } finally {
      log.close();
    }
    const recording = join(dir, "sessions", seed.sessionId, "recording"),
      manifest = readManifest(recording);
    expect(manifest?.ok && manifest.manifest.state).toBe("complete");
    const input = new Input({
      source: new BufferSource(readFileSync(join(recording, "video.mp4"))),
      formats: [MP4],
    });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("missing seed video");
      const sink = new EncodedPacketSink(track);
      const stamps = [];
      for await (const packet of sink.packets()) stamps.push(packet.microsecondTimestamp);
      expect(stamps).toEqual(seed.frames.map((f) => f.tMicros));
    } finally {
      input.dispose();
    }
    expect(readdirSync(join(dir, "sessions", seed.sessionId, "frames"))).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(dir, `seed-${seed.sessionId}.json`), "utf8"))).toEqual(
      seed,
    );
  });
  it("omits takeover frames and resumes from a key frame", async () => {
    const dir = home(),
      span = { fromMs: 600, toMs: 750 },
      seed = await seedSession({ home: dir, minutes: 0.25, takeover: span });
    expect(seed.frames.some((f) => f.tMicros >= 600000 && f.tMicros < 750000)).toBe(false);
    const resumed = seed.frames.find((f) => f.tMicros >= 750000);
    expect(resumed).toBeDefined();
    expect((resumed?.index ?? -1) % seed.synth.keyEvery).toBe(0);
    const log = new EventLog(dir);
    try {
      expect(log.read(seed.sessionId).filter((e) => e.type === "control.change")).toHaveLength(2);
    } finally {
      log.close();
    }
    const read = readManifest(join(dir, "sessions", seed.sessionId, "recording"));
    expect(read?.ok && read.manifest.gaps).toEqual([
      { from: 600000, to: resumed?.tMicros, reason: "user-control" },
    ]);
  });
  it("keeps the marker in the title and one public typed chunk without ever serializing a masked chunk", async () => {
    const dir = home(),
      marker = "seed-review-marker",
      seed = await seedSession({ home: dir, minutes: 1, marker });
    const log = new EventLog(dir);
    try {
      const events = log.read(seed.sessionId);
      expect(events.some((e) => e.type === "session.start" && e.data.title?.includes(marker))).toBe(
        true,
      );
      expect(events.some((e) => e.type === "text.progress" && e.data.chunk === marker)).toBe(true);
      expect(
        events.some(
          (e) => e.type === "text.progress" && e.data.masked && e.data.chunk !== undefined,
        ),
      ).toBe(false);
    } finally {
      log.close();
    }
  });
  it("supports observation-only seeds and rejects bad options before writing a session", async () => {
    const dir = home(),
      seed = await seedSession({ home: dir, minutes: 0.1, video: false });
    const read = readManifest(join(dir, "sessions", seed.sessionId, "recording"));
    expect(read?.ok && read.manifest.state).toBe("none");
    expect(seed.frames).toEqual([]);
    await expect(seedSession({ home: dir, minutes: 0 })).rejects.toThrow(RangeError);
  });
});
