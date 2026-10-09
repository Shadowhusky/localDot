import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ReplaySource } from "../stage/worker-protocol.ts";
import { ReplayVideo } from "./replay-video.ts";

const fixture = vi.hoisted(() => ({
  canDecode: vi.fn(),
  dispose: vi.fn(),
  getFirstPacket: vi.fn(),
  getPacket: vi.fn(),
  getKeyPacket: vi.fn(),
  getSample: vi.fn(),
  samples: vi.fn(),
}));
vi.mock("./recording-source.ts", () => ({
  openRecording: () => ({
    dispose: fixture.dispose,
    getPrimaryVideoTrack: async () => ({ canDecode: fixture.canDecode, codec: "avc" }),
  }),
}));
vi.mock("mediabunny", () => ({
  EncodedPacketSink: class {
    getFirstPacket = fixture.getFirstPacket;
    getPacket = fixture.getPacket;
    getKeyPacket = fixture.getKeyPacket;
  },
  VideoSampleSink: class {
    getSample = fixture.getSample;
    samples = fixture.samples;
  },
}));

const source: ReplaySource = {
  sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  origin: "https://localdot.test",
  authorization: "Bearer fixture",
  video: { upto: null },
  gaps: [],
};
const timestamps = [100, 120, 140, 300, 320, 340, 2200, 2220];
interface FakeFrame {
  timestamp: number;
  close: Mock;
  clone(): VideoFrame;
}
interface FakeSample {
  timestamp: number;
  microsecondTimestamp: number;
  close: Mock;
  toVideoFrame(): VideoFrame;
}
let samples: FakeSample[] = [];

function fakeFrame(timestamp: number): FakeFrame {
  const frame = {
    timestamp,
    close: vi.fn(),
    clone: () => fakeFrame(timestamp) as unknown as VideoFrame,
  };
  return frame;
}
function fakeSample(timestampMs: number): FakeSample {
  const sample = {
    timestamp: timestampMs / 1000,
    microsecondTimestamp: timestampMs * 1000,
    close: vi.fn(),
    toVideoFrame: () => fakeFrame(timestampMs * 1000) as unknown as VideoFrame,
  };
  samples.push(sample);
  return sample;
}
function packet(timestampMs: number) {
  return {
    timestamp: timestampMs / 1000,
    microsecondTimestamp: timestampMs * 1000,
    microsecondDuration: 20_000,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  samples = [];
  fixture.canDecode.mockResolvedValue(true);
  fixture.getFirstPacket.mockResolvedValue(packet(100));
  fixture.getPacket.mockResolvedValue(packet(2220));
  fixture.getKeyPacket.mockImplementation(async (seconds: number) => {
    const key = [100, 300, 2200].filter((time) => time <= seconds * 1000).at(-1);
    return key === undefined ? null : packet(key);
  });
  fixture.getSample.mockImplementation(async (seconds: number) => {
    const selected = timestamps.filter((time) => time <= Math.round(seconds * 1000)).at(-1);
    return selected === undefined ? null : fakeSample(selected);
  });
  fixture.samples.mockImplementation(async function* (seconds: number) {
    for (const timestamp of timestamps) {
      if (timestamp >= Math.round(seconds * 1000)) yield fakeSample(timestamp);
    }
  });
});

describe("ReplayVideo ownership and scheduling", () => {
  it("sequential exports advance to the exact frame across idle jumps without another seek", async () => {
    const video = await ReplayVideo.open(source, undefined, { sequential: true });
    (await video.want(125, "play"))?.close();
    const advanced = await video.want(2225, "play");
    expect(advanced?.timestamp).toBe(2_220_000);
    expect(video.stats().seeks).toBe(1);
    expect(video.stats().openFrames).toBeLessThanOrEqual(3);
    advanced?.close();
    const tail = await video.want(2239, "play");
    expect(tail?.timestamp).toBe(2_220_000);
    expect(video.stats().seeks).toBe(1);
    tail?.close();
    video.close();
    expect(video.stats().openFrames).toBe(0);
  });
  it("opens bounded metadata and disposes unsupported input", async () => {
    const video = await ReplayVideo.open(source);
    expect([video.firstMs, video.lastMs]).toEqual([100, 2240]);
    expect(fixture.getPacket).toHaveBeenCalledWith(Infinity, { metadataOnly: true });
    video.close();
    fixture.canDecode.mockResolvedValue(false);
    await expect(ReplayVideo.open(source)).rejects.toThrow("cannot decode the recording (avc)");
    expect(fixture.dispose).toHaveBeenCalledTimes(2);
  });

  it("returns the last frame before an exact target, then advances without another seek", async () => {
    const video = await ReplayVideo.open(source);
    const first = await video.want(135, "exact");
    expect(first?.timestamp).toBe(120_000);
    expect(video.stats().openFrames).toBe(3);
    first?.close();
    const advanced = await video.want(145, "exact");
    expect(advanced?.timestamp).toBe(140_000);
    advanced?.close();
    expect(video.stats().seeks).toBe(1);
    const held = await video.want(150, "exact");
    expect(held?.timestamp).toBe(140_000);
    held?.close();
    expect(video.stats().seeks).toBe(1);
    video.close();
    expect(video.stats().openFrames).toBe(0);
    expect(samples.every((sample) => sample.close.mock.calls.length === 1)).toBe(true);
  });

  it("re-seeks backward and uses only a key frame for previews and long play jumps", async () => {
    const video = await ReplayVideo.open(source);
    (await video.want(340, "exact"))?.close();
    const backward = await video.want(125, "exact");
    expect(backward?.timestamp).toBe(120_000);
    backward?.close();
    const preview = await video.want(345, "preview");
    expect(preview?.timestamp).toBe(300_000);
    preview?.close();
    (await video.want(125, "exact"))?.close();
    const jump = await video.want(2220, "play");
    expect(jump?.timestamp).toBe(2_200_000);
    jump?.close();
    video.close();
  });

  it("coalesces a drag while a decode is pending and closes its obsolete sample", async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let obsolete: ReturnType<typeof fakeSample> | undefined;
    fixture.getSample.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      obsolete = fakeSample(120);
      return obsolete;
    });
    const video = await ReplayVideo.open(source);
    const initial = video.want(125, "exact");
    await entered.promise;
    const drag = Array.from({ length: 100 }, (_, index) => video.want(300 + index / 2, "preview"));
    expect(video.stats().decodeQueue).toBe(2);
    resume.resolve();
    expect(await initial).toBeNull();
    const outputs = await Promise.all(drag);
    expect(outputs.slice(0, -1).every((frame) => frame === null)).toBe(true);
    expect(outputs.at(-1)?.timestamp).toBe(300_000);
    expect(obsolete?.close).toHaveBeenCalledTimes(1);
    expect(fixture.getSample).toHaveBeenCalledTimes(2);
    expect(video.stats().openFrames).toBeLessThanOrEqual(3);
    outputs.at(-1)?.close();
    video.close();
  });

  it("previews a drag from key frames alone, then seeks the exact frame on release", async () => {
    const video = await ReplayVideo.open(source);
    for (const target of [125, 345, 330, 2210, 140, 350]) {
      (await video.want(target, "preview"))?.close();
      expect(video.stats().openFrames).toBe(1);
    }
    expect(fixture.samples).not.toHaveBeenCalled();
    expect(fixture.getSample.mock.calls.map(([seconds]) => seconds * 1000)).toEqual([
      100, 300, 2200, 100, 300,
    ]);
    expect(video.stats().decoded).toBe(5);
    const released = await video.want(345, "exact");
    expect(released?.timestamp).toBe(340_000);
    released?.close();
    expect(fixture.samples).toHaveBeenCalledTimes(1);
    video.close();
    expect(video.stats().openFrames).toBe(0);
    expect(samples.every((sample) => sample.close.mock.calls.length === 1)).toBe(true);
  });

  it("settles shutdown during a decode and closes its late sample", async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    fixture.getSample.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return fakeSample(120);
    });
    const video = await ReplayVideo.open(source);
    const current = video.want(125, "exact");
    await entered.promise;
    const queued = video.want(330, "exact");
    video.close();
    expect(await queued).toBeNull();
    resume.resolve();
    expect(await current).toBeNull();
    expect(video.stats()).toMatchObject({ openFrames: 0, decodeQueue: 0 });
    expect(samples.every((sample) => sample.close.mock.calls.length === 1)).toBe(true);
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
  });

  it("clears frames before the first packet and preserves caller ownership after shutdown", async () => {
    const video = await ReplayVideo.open(source);
    const owned = await video.want(145, "exact");
    expect(await video.want(0, "exact")).toBeNull();
    expect(video.stats().openFrames).toBe(1);
    video.close();
    expect(owned?.timestamp).toBe(140_000);
    owned?.close();
    owned?.close();
    expect(video.stats().openFrames).toBe(0);
    await expect(video.want(Number.NaN, "exact")).rejects.toThrow("Invalid replay time");
  });
});
