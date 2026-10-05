import { synthFrame } from "@localdot/stage/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monotonicClock } from "../clock.ts";
import { type FeedFrame, PIPELINE_RESET, SelkiesFeed, type SelkiesFeedOptions } from "./feed.ts";
import { type FakeSelkies, startFakeSelkies } from "./testing/fake-selkies.ts";

const AUTH = "Basic bG9jYWxkb3Q6czktdGVzdC1ub3QtYS1zZWNyZXQ=";
const servers: FakeSelkies[] = [];
const feeds: SelkiesFeed[] = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = (check: () => void, timeout = 5000) => vi.waitFor(check, { timeout, interval: 20 });
async function server(): Promise<FakeSelkies> {
  const s = await startFakeSelkies({ authorization: AUTH });
  servers.push(s);
  return s;
}
function feedFor(s: FakeSelkies, extra: Partial<SelkiesFeedOptions> = {}) {
  const frames: FeedFrame[] = [];
  const states: { state: string; detail?: string }[] = [];
  const feed = new SelkiesFeed({
    endpoint: () => ({ baseUrl: s.baseUrl, authorization: AUTH }),
    clock: monotonicClock(),
    handlers: {
      onFrame: (frame) => frames.push(frame),
      onState: (state, detail) => states.push({ state, ...(detail ? { detail } : {}) }),
    },
    ...extra,
  });
  feeds.push(feed);
  feed.start();
  return { feed, frames, states };
}
function raw(payload: Uint8Array, flags: number, region = 0): Uint8Array {
  const data = new Uint8Array(12 + payload.length);
  const v = new DataView(data.buffer);
  v.setUint8(0, 4);
  v.setUint8(1, flags);
  v.setUint16(4, region);
  v.setUint16(6, 64);
  v.setUint16(8, 64);
  data.set(payload, 12);
  return data;
}
afterEach(async () => {
  for (const feed of feeds.splice(0)) feed.stop();
  const outcomes = await Promise.allSettled(servers.splice(0).map((s) => s.close()));
  vi.restoreAllMocks();
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
});

describe("passive Selkies recording feed", () => {
  it("speaks the passive handshake and nothing else", async () => {
    const s = await server();
    const { frames } = feedFor(s);
    await s.waitForText("START_VIDEO");
    await delay(2000);
    expect(frames.length).toBeGreaterThan(60);
    expect(s.texts).toEqual(["STOP_VIDEO", "START_VIDEO"]);
    expect((s.textTimes[1] ?? 0) - (s.textTimes[0] ?? 0)).toBeGreaterThanOrEqual(245);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.url).toBe("/api/websockets?role=viewer");
  });
  it("stamps frames with the daemon clock and flags only real key frames", async () => {
    const s = await server();
    const { frames } = feedFor(s, { clock: { nowMicros: () => 7_123_456 } });
    await until(() => expect(frames.length).toBeGreaterThan(2));
    expect(frames.every((frame) => frame.arrivalMicros === 7_123_456)).toBe(true);
    expect(frames[0]).toMatchObject({ key: true, width: 64, height: 64 });
    s.still(true);
    const before = frames.length;
    s.sendRaw(raw(synthFrame({ widthMbs: 4, heightMbs: 4, keyEvery: 12 }, 1).data, 0x11));
    await until(() => expect(frames.length).toBe(before + 1));
    expect(frames.at(-1)?.key).toBe(false);
  });
  it("asks for a key frame at most every 500 ms", async () => {
    const s = await server();
    const { feed } = feedFor(s);
    await s.waitForText("START_VIDEO");
    for (let i = 0; i < 10; i++) feed.requestKeyframe();
    await s.waitForText("REQUEST_KEYFRAME");
    await delay(100);
    expect(s.texts.filter((text) => text === "REQUEST_KEYFRAME")).toHaveLength(1);
    await delay(430);
    feed.requestKeyframe();
    await until(() =>
      expect(s.texts.filter((text) => text === "REQUEST_KEYFRAME")).toHaveLength(2),
    );
  });
  it("drops frames of another codec or region and reports it once", async () => {
    const s = await server();
    const { frames, states } = feedFor(s);
    await until(() => expect(frames.length).toBeGreaterThan(1));
    s.still(true);
    await delay(30);
    const before = frames.length;
    const key = synthFrame({ widthMbs: 4, heightMbs: 4, keyEvery: 12 }, 0).data;
    s.sendRaw(raw(key, 0x21));
    s.sendRaw(raw(key, 0x11, 1));
    await delay(80);
    expect(frames).toHaveLength(before);
    expect(
      states.filter((row) => row.detail === "ignored a non-H.264 or striped frame"),
    ).toHaveLength(1);
  });
  it("redials with backoff after the cell closes the socket, re-reading the endpoint", async () => {
    const a = await server();
    const b = await server();
    let endpoint = a;
    let reads = 0;
    const { states } = feedFor(a, {
      endpoint: () => {
        reads++;
        return { baseUrl: endpoint.baseUrl, authorization: AUTH };
      },
    });
    await a.waitForText("START_VIDEO");
    endpoint = b;
    const closedAt = performance.now();
    a.closeAll();
    await b.waitForText("START_VIDEO");
    expect(performance.now() - closedAt).toBeGreaterThanOrEqual(735);
    expect(states.map((row) => row.state)).toEqual([
      "connecting",
      "live",
      "lost",
      "connecting",
      "live",
    ]);
    expect(reads).toBe(2);
    expect(b.requests).toHaveLength(1);
  });
  it("treats 1.5 s without a message or pong as lost and redials", async () => {
    const s = await server();
    const { states } = feedFor(s, { pingEveryMs: 100 });
    await s.waitForText("START_VIDEO");
    await delay(80);
    const quietAt = performance.now();
    s.silence();
    await until(() => expect(states.some((row) => row.state === "lost")).toBe(true), 2200);
    expect(performance.now() - quietAt).toBeGreaterThanOrEqual(1400);
    expect(performance.now() - quietAt).toBeLessThan(2000);
  });
  it("re-sends START_VIDEO after a pipeline reset stops the video, and the video resumes", async () => {
    const s = await server();
    const { frames, states } = feedFor(s, { videoRestartAfterMs: 300 });
    await s.waitForText("START_VIDEO");
    await delay(1000);
    const before = frames.length;
    s.resetPipeline();
    const resetAt = performance.now();
    await until(() => expect(frames.length).toBeGreaterThan(before));
    expect(frames[before]?.key).toBe(true);
    expect(performance.now() - resetAt).toBeGreaterThanOrEqual(250);
    expect(performance.now() - resetAt).toBeLessThan(500);
    expect(states.filter((row) => row.detail === PIPELINE_RESET)).toHaveLength(1);
    expect(s.texts).toEqual(["STOP_VIDEO", "START_VIDEO", "START_VIDEO"]);
    expect(s.requests).toHaveLength(1);
  });
  it("backs off its START_VIDEO re-sends on a still screen and resets on video", async () => {
    const s = await server();
    const { frames, states } = feedFor(s, { videoRestartAfterMs: 300 });
    await until(() => expect(frames.length).toBeGreaterThan(3));
    s.still(true);
    const stillAt = performance.now();
    await delay(2400);
    const starts = s.textTimes.filter((_t, index) => s.texts[index] === "START_VIDEO").slice(1);
    expect(starts).toHaveLength(3);
    expect((starts[0] ?? 0) - stillAt).toBeGreaterThan(200);
    expect((starts[0] ?? 0) - stillAt).toBeLessThan(400);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThan(500);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeLessThan(700);
    expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBeGreaterThan(1100);
    expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBeLessThan(1300);
    const before = frames.length;
    s.still(false);
    await until(() => expect(frames.length).toBeGreaterThan(before + 1));
    s.still(true);
    const againAt = performance.now();
    await until(() => expect(s.texts.filter((text) => text === "START_VIDEO")).toHaveLength(5));
    expect(performance.now() - againAt).toBeGreaterThan(200);
    expect(performance.now() - againAt).toBeLessThan(450);
    expect(states.every((row) => row.state !== "lost")).toBe(true);
    expect(s.requests).toHaveLength(1);
  }, 10_000);
  it("sends the stream credential only in the Authorization header", async () => {
    const s = await server();
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => {
        logs.push(args.map(String).join(" "));
      });
    const { feed, states } = feedFor(s);
    await s.waitForText("START_VIDEO");
    s.closeAll();
    await until(() => expect(states.some((row) => row.state === "lost")).toBe(true));
    feed.stop();
    expect(s.requests.every((request) => request.headers.authorization === AUTH)).toBe(true);
    expect(
      s.requests.every(
        (request) => !request.url.includes("czktdGVzdC") && !request.url.includes("s9-test"),
      ),
    ).toBe(true);
    expect(
      [...logs, ...states.map((row) => `${row.state} ${row.detail ?? ""}`)].some(
        (text) => text.includes("czktdGVzdC") || text.includes("s9-test"),
      ),
    ).toBe(false);
  });
  it("stop() closes and never redials", async () => {
    const s = await server();
    const { feed, states } = feedFor(s);
    await s.waitForText("START_VIDEO");
    feed.stop();
    const count = s.requests.length;
    await delay(5000);
    expect(s.requests).toHaveLength(count);
    expect(states.at(-1)?.state).toBe("stopped");
  }, 10_000);
  it("stop during the handshake prevents its delayed START_VIDEO", async () => {
    const s = await server();
    const { feed, states } = feedFor(s);
    await s.waitForText("STOP_VIDEO");
    feed.stop();
    await delay(850);
    expect(s.texts).toEqual(["STOP_VIDEO"]);
    expect(s.requests).toHaveLength(1);
    expect(states.at(-1)?.state).toBe("stopped");
  });
  it("a connecting-state handler can stop before any socket is created", async () => {
    const s = await server();
    let feed: SelkiesFeed;
    let reads = 0;
    feed = new SelkiesFeed({
      endpoint: () => {
        reads++;
        return { baseUrl: s.baseUrl, authorization: AUTH };
      },
      clock: monotonicClock(),
      handlers: {
        onFrame: () => {},
        onState: (state) => {
          if (state === "connecting") feed.stop();
        },
      },
    });
    feeds.push(feed);
    feed.start();
    await delay(600);
    expect(reads).toBe(0);
    expect(s.requests).toHaveLength(0);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid watchdog intervals %s",
    (videoRestartAfterMs) => {
      expect(
        () =>
          new SelkiesFeed({
            endpoint: () => undefined,
            clock: monotonicClock(),
            handlers: { onFrame: () => {}, onState: () => {} },
            videoRestartAfterMs,
          }),
      ).toThrow(RangeError);
    },
  );
});
