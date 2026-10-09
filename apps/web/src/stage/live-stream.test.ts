// @vitest-environment jsdom
import { qualityMessage } from "@localdot/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { fakeChromium, playInClient } from "../testing/fake-chromium.ts";
import type { FrameSource } from "./frame-source.ts";
import {
  closeStreams,
  holdStream,
  KEEP_MS,
  STALE_MS,
  TAP_STALL_MS,
  TRACK_PROOF_MS,
  TUNE_MS,
} from "./live-stream.ts";
import { chooseStreamPreference } from "./stream-preference.ts";

const CELL = "01JXYZ0000000000000000ABCD";
const ticket = (n: number) => `/cells/${CELL}/desktop/${String(n).padStart(22, "T")}/`;
const clients = () => [...document.querySelectorAll<HTMLIFrameElement>("iframe.desktop-frame")];

// The daemon answers the n-th ticket request with `answer(n)`.
function daemon(answer: (n: number) => Response) {
  let minted = 0;
  const fetchImpl = (async () => answer(++minted)) as typeof fetch;
  return { api: createApi("a".repeat(43), { fetchImpl }), minted: () => minted };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});
afterEach(() => {
  closeStreams();
  vi.useRealTimers();
});

it("lets a stream go at once when its computer stops, or a minute after its stage leaves", async () => {
  const { api } = daemon((n) => Response.json({ path: ticket(n) }));
  const target = { api, cellId: CELL, surface: "desktop" as const };
  const first = holdStream(target, () => [CELL]);
  await vi.advanceTimersByTimeAsync(0);
  expect(clients()).toHaveLength(1);
  first.release(KEEP_MS);
  await vi.advanceTimersByTimeAsync(KEEP_MS - 1);
  const again = holdStream(target, () => [CELL]);
  expect(again.stream).toBe(first.stream);
  const other = holdStream(target, () => [CELL]);
  await vi.advanceTimersByTimeAsync(KEEP_MS * 2);
  expect(clients()).toHaveLength(1);
  again.release(0);
  expect(clients()).toHaveLength(1);
  other.release(0);
  expect(clients()).toHaveLength(0);
  expect(holdStream(target, () => [CELL]).stream).not.toBe(first.stream);
});

it("gives a client that keeps failing to load longer each time, instead of reloading every 10 s", async () => {
  const { api, minted } = daemon((n) => Response.json({ path: ticket(n) }));
  const { stream } = holdStream({ api, cellId: CELL, surface: "desktop" }, () => [CELL]);
  stream.connect(() => {});
  await vi.advanceTimersByTimeAsync(250);
  expect(minted()).toBe(1);
  await vi.advanceTimersByTimeAsync(STALE_MS);
  expect(minted()).toBe(2);
  expect(clients().map((frame) => frame.getAttribute("src"))).toEqual([`${ticket(2)}#shared`]);
  await vi.advanceTimersByTimeAsync(STALE_MS);
  expect(minted()).toBe(2);
  await vi.advanceTimersByTimeAsync(STALE_MS);
  expect(minted()).toBe(3);
});

it("asks again for a ticket the daemon refused, less often each time", async () => {
  const { api, minted } = daemon(() => new Response("not ready", { status: 409 }));
  const { stream } = holdStream({ api, cellId: CELL, surface: "desktop" }, () => [CELL]);
  stream.connect(() => {});
  await vi.advanceTimersByTimeAsync(250);
  expect(minted()).toBe(1);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(minted()).toBe(2);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(minted()).toBe(2);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(minted()).toBe(3);
  expect(clients()).toHaveLength(0);
});

it("tells its relay each second what this viewer can take, from the round trip the relay reports, and that a hidden page asks for nothing", async () => {
  const restore = fakeChromium();
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  try {
    const { api } = daemon(() => Response.json({ path: ticket(1) }));
    const { stream } = holdStream({ api, cellId: CELL, surface: "desktop" }, () => [CELL]);
    stream.connect(() => {});
    await vi.advanceTimersByTimeAsync(250);
    const [frame] = clients();
    const view = frame?.contentWindow;
    if (!frame || !view) throw new Error("no client");
    playInClient(frame, "track-1");
    const send = vi.fn();
    const asked: unknown[] = [];
    view.addEventListener("message", (event) => asked.push(event.data));
    // Selkies' client, once asked, keeps its numbers with the relay's round trip each second.
    let rtt = 80;
    const stats = { open: false, latest: null as { t: number; rtt_ms: number } | null };
    Object.assign(view, { selkiesTransport: { readyState: 1, send }, stream_stats: stats });
    const second = async () => {
      if (stats.open) stats.latest = { t: Date.now(), rtt_ms: rtt };
      await vi.advanceTimersByTimeAsync(1_000);
    };
    await second();
    expect(send).toHaveBeenCalledWith(qualityMessage({ visible: true, framerate: 60, crf: 25 }));
    expect(asked).toContainEqual({ type: "statsOpen", open: true });

    stats.open = true;
    for (let n = 0; n < 5; n++) await second();
    rtt = 1_500;
    for (let n = 0; n < 2; n++) await second();
    expect(send).toHaveBeenLastCalledWith(
      qualityMessage({ visible: true, framerate: 60, crf: 41 }),
    );

    send.mockClear();
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(250);
    expect(send.mock.calls).toEqual([[qualityMessage({ visible: false })]]);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
    restore();
  }
});

// A Chromium client whose relay reports `rtt()` each second once its numbers are asked for, on a
// touch screen when `coarse`.
async function relayClient(rtt: () => number = () => 80, coarse = false) {
  const restore = fakeChromium();
  if (coarse)
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      addEventListener() {},
      removeEventListener() {},
    }));
  const { api, minted } = daemon((n) => Response.json({ path: ticket(n) }));
  const held = holdStream({ api, cellId: CELL, surface: "desktop" }, () => [CELL]);
  const disconnect = held.stream.connect(() => {});
  await vi.advanceTimersByTimeAsync(250);
  const [frame] = clients();
  const view = frame?.contentWindow;
  if (!frame || !view) throw new Error("no client");
  playInClient(frame, "track-1");
  const send = vi.fn();
  const stats = { open: true, latest: null as { t: number; rtt_ms: number } | null };
  const transport = { readyState: 1, send };
  Object.assign(view, { selkiesTransport: transport, stream_stats: stats });
  const second = async () => {
    stats.latest = { t: Date.now(), rtt_ms: rtt() };
    await vi.advanceTimersByTimeAsync(1_000);
  };
  const reports = () =>
    send.mock.calls.map(([text]) => text).filter((text) => String(text).startsWith("_ld_q"));
  return { ...held, disconnect, send, transport, second, reports, minted, restore };
}

it("asks for full quality on a phone too, from its first report", async () => {
  const { second, send, restore } = await relayClient(undefined, true);
  try {
    await second();
    expect(send).toHaveBeenCalledWith(qualityMessage({ visible: true, framerate: 60, crf: 25 }));
    expect(send).not.toHaveBeenCalledWith(
      qualityMessage({ visible: true, framerate: 30, crf: 25 }),
    );
  } finally {
    restore();
  }
});

it("gives up frames before detail on a queued link once the viewer chose Sharp", async () => {
  let rtt = 80;
  const { second, reports, restore } = await relayClient(() => rtt);
  try {
    for (let n = 0; n < 4; n++) await second();
    chooseStreamPreference("sharp");
    rtt = 400;
    for (let n = 0; n < 3; n++) await second();
    expect(reports().at(-1)).toBe(qualityMessage({ visible: true, framerate: 45, crf: 25 }));
  } finally {
    chooseStreamPreference("auto");
    restore();
  }
});

it("tells its relay it asks for nothing once no stage shows it, unless a stage takes it at once", async () => {
  const { stream, disconnect, second, reports, restore } = await relayClient();
  try {
    await second();
    disconnect();
    const again = stream.connect(() => {});
    await vi.advanceTimersByTimeAsync(TUNE_MS * 2);
    expect(reports()).not.toContain(qualityMessage({ visible: false }));
    again();
    await vi.advanceTimersByTimeAsync(TUNE_MS);
    expect(reports().at(-1)).toBe(qualityMessage({ visible: false }));
  } finally {
    restore();
  }
});

it("keeps its client when the page comes back after a long time hidden, unless its socket died", async () => {
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const { stream, minted, transport, restore } = await relayClient();
  try {
    expect(minted()).toBe(1);
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(250);
    // A backgrounded phone runs no timers at all.
    vi.setSystemTime(Date.now() + STALE_MS * 3);
    visibility = "visible";
    stream.refresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(minted()).toBe(1);
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(250);
    vi.setSystemTime(Date.now() + STALE_MS * 3);
    visibility = "visible";
    // A timer that fires before the page hears it is visible again changes nothing either.
    await vi.advanceTimersByTimeAsync(250);
    expect(minted()).toBe(1);
    transport.readyState = 3;
    stream.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(minted()).toBe(2);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
    restore();
  }
});

// Safari: no MediaStreamTrackProcessor on the page. Its client counts decoded frames itself, as
// WebKit's video counts none of a track a worker writes.
async function safariClient(frames: boolean) {
  const restore = fakeChromium();
  vi.stubGlobal("MediaStreamTrackProcessor", undefined);
  const { api } = daemon(() => Response.json({ path: ticket(1) }));
  const { stream, release } = holdStream({ api, cellId: CELL, surface: "desktop" }, () => [CELL]);
  const sources: FrameSource[] = [];
  stream.connect((source) => sources.push(source));
  await vi.advanceTimersByTimeAsync(250);
  const [frame] = clients();
  const view = frame?.contentWindow as (Window & { videoChunksReceived: number }) | null;
  if (!frame || !view) throw new Error("no client");
  playInClient(frame, "track-1");
  if (frames)
    Object.defineProperty(
      frame.contentDocument?.getElementById("videoStream"),
      "requestVideoFrameCallback",
      {
        value: () => 1,
      },
    );
  const send = vi.fn();
  Object.assign(view, { selkiesTransport: { readyState: 1, send }, videoChunksReceived: 0 });
  const keyframes = () => send.mock.calls.filter(([text]) => text === "REQUEST_KEYFRAME").length;
  return { stream, release, sources, view, keyframes, restore };
}

it("asks for a key frame at once for a tap without the video's frame, as a still screen sends none", async () => {
  const { sources, keyframes, restore } = await safariClient(false);
  try {
    await vi.advanceTimersByTimeAsync(250);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.track).toBeDefined();
    expect(sources[0]?.first).toBeUndefined();
    expect(keyframes()).toBe(1);
  } finally {
    restore();
  }
});

it("copies the video's frames once the worker's read of the track twice showed nothing while the decoder ran", async () => {
  const { sources, view, restore } = await safariClient(true);
  try {
    await vi.advanceTimersByTimeAsync(250);
    expect(sources.map((source) => !!source.track)).toEqual([true]);
    view.videoChunksReceived = 30;
    await vi.advanceTimersByTimeAsync(TRACK_PROOF_MS);
    expect(sources.map((source) => !!source.track)).toEqual([true, true]);
    view.videoChunksReceived = 60;
    await vi.advanceTimersByTimeAsync(TRACK_PROOF_MS);
    expect(sources.map((source) => !!source.track)).toEqual([true, true, false]);
    expect(sources[2]?.frames).toBeTypeOf("function");
  } finally {
    restore();
  }
});

it("never makes a later stream wait out a track read that failed", async () => {
  const first = await safariClient(true);
  try {
    await vi.advanceTimersByTimeAsync(250);
    for (const chunks of [30, 60]) {
      first.view.videoChunksReceived = chunks;
      await vi.advanceTimersByTimeAsync(TRACK_PROOF_MS);
    }
    expect(first.sources.map((source) => !!source.track)).toEqual([true, true, false]);
    first.release(0);
  } finally {
    first.restore();
  }
  const later = await safariClient(true);
  try {
    await vi.advanceTimersByTimeAsync(250);
    expect(later.sources.map((source) => !!source.track)).toEqual([false]);
  } finally {
    later.restore();
  }
});

it("keeps handing the worker the track once it showed a frame", async () => {
  const { stream, sources, view, restore } = await safariClient(true);
  try {
    await vi.advanceTimersByTimeAsync(250);
    stream.presented(1);
    view.videoChunksReceived = 30;
    await vi.advanceTimersByTimeAsync(TRACK_PROOF_MS);
    expect(sources).toHaveLength(1);
    // The stall that follows takes the tap again, still with a track.
    for (let ms = 0; ms <= TAP_STALL_MS; ms += 250) {
      view.videoChunksReceived += 8;
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(sources.map((source) => !!source.track)).toEqual([true, true]);
  } finally {
    restore();
  }
});
