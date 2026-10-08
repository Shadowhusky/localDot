import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyManifest,
  type LocalDotEvent,
  RecordingInfo,
  SessionIndexPage,
} from "@localdot/protocol";
import { SYNTH_CODEC, synthFrame } from "@localdot/stage/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { monotonicClock } from "../clock.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { writeManifest } from "../recorder/manifest.ts";
import { Recorder } from "../recorder/recorder.ts";
import { seedSession } from "../recorder/testing/seed-session.ts";
import { RecordingWriter } from "../recorder/writer.ts";
import { SessionIndex } from "./index-store.ts";
import { Thumbnails } from "./thumbs.ts";

const token = "route-test-token-0123456789abcdefghijklmnop";
const headers = { authorization: `Bearer ${token}` };
const roots: string[] = [];
const logs: EventLog[] = [];
const indexes: SessionIndex[] = [];
const writers: RecordingWriter[] = [];
async function setup(withBrowser = true) {
  const home = mkdtempSync(join(tmpdir(), "localdot-replay-routes-"));
  roots.push(home);
  const seed = await seedSession({ home, minutes: 0.1, video: false });
  const log = new EventLog(home);
  logs.push(log);
  const recorder = new Recorder({
    home,
    eventLog: log,
    cells: { get: () => undefined, endpoints: () => undefined },
    clock: monotonicClock(),
  });
  const liveIds = new Set<string>();
  const browser = new Recorder({
    home,
    eventLog: log,
    screen: "browser",
    cells: { get: () => undefined, endpoints: () => undefined },
    clock: monotonicClock(),
  });
  const controlledIds = new Set<string>();
  const liveWriters = new Map<string, RecordingWriter>();
  const index = new SessionIndex(home, { isLive: (id) => liveIds.has(id) });
  indexes.push(index);
  const app = createApp({
    token,
    port: 4790,
    eventLog: log,
    replay: {
      home,
      eventLog: log,
      index,
      thumbs: new Thumbnails(home, new FrameStore(home)),
      live: { cellOf: (id) => (controlledIds.has(id) ? "test-cell" : undefined) },
      recorder: {
        ...(withBrowser ? { browser } : {}),
        isLive: (id) => liveIds.has(id),
        info: (id) => {
          const writer = liveWriters.get(id);
          return writer
            ? {
                live: true,
                entries: writer.entries,
                manifest: {
                  ...emptyManifest("recording"),
                  codec: SYNTH_CODEC,
                  width: 64,
                  height: 64,
                  fragments: writer.entries.length,
                },
              }
            : recorder.info(id);
        },
      },
    },
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(`http://127.0.0.1:4790${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
    });
  return { home, seed, log, index, request, liveIds, controlledIds, liveWriters };
}
afterEach(() => {
  for (const writer of writers.splice(0)) writer.close();
  for (const index of indexes.splice(0)) index.close();
  for (const log of logs.splice(0)) log.close();
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("replay APIs", () => {
  it("serves each physical recording's bytes, range and metadata independently", async () => {
    const { home, seed, request } = await setup();
    const sessionId = seed.sessionId;
    const bytes = new Map<string, Uint8Array>();
    for (const [screen, widthMbs] of [
      ["desktop", 4],
      ["browser", 5],
    ] as const) {
      const dir = join(
        home,
        "sessions",
        sessionId,
        screen === "desktop" ? "recording" : "recording-browser",
      );
      const writer = new RecordingWriter({
        dir,
        codec: SYNTH_CODEC,
        width: widthMbs * 16,
        height: 64,
      });
      writers.push(writer);
      await writer.start();
      for (let i = 0; i < 14; i++)
        await writer.push({
          ...synthFrame({ widthMbs, heightMbs: 4, keyEvery: 4 }, i),
          tMicros: i * 16667,
        });
      await writer.finish(250000);
      bytes.set(screen, new Uint8Array(readFileSync(join(dir, "video.mp4"))));
      writeManifest(dir, {
        ...emptyManifest("complete"),
        codec: SYNTH_CODEC,
        width: widthMbs * 16,
        height: 64,
        fragments: writer.entries.length,
        bytes: bytes.get(screen)!.length,
        finalized: true,
      });
    }
    const base = `/api/sessions/${sessionId}/recording`;
    for (const screen of ["desktop", "browser"] as const) {
      const info = RecordingInfo.parse(await (await request(`${base}?screen=${screen}`)).json());
      expect(info.manifest.width).toBe(screen === "desktop" ? 64 : 80);
      const response = await request(`${base}/video.mp4?screen=${screen}`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.get(screen));
      const range = await request(`${base}/video.mp4?screen=${screen}`, {
        headers: { range: "bytes=20-95" },
      });
      expect(range.status).toBe(206);
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(bytes.get(screen)?.slice(20, 96));
      const head = await request(`${base}/video.mp4?screen=${screen}`, { method: "HEAD" });
      expect(Number(head.headers.get("content-length"))).toBe(info.servedBytes);
      expect(await head.text()).toBe("");
    }
    expect(new Uint8Array(await (await request(`${base}/video.mp4`)).arrayBuffer())).toEqual(
      bytes.get("desktop"),
    );
    for (const query of [
      "screen=",
      "screen=other",
      "screen=browser&screen=desktop",
      "screen=browser&screen=browser",
      "screen=../recording",
    ]) {
      expect((await request(`${base}?${query}`)).status).toBe(400);
      expect((await request(`${base}/video.mp4?${query}`)).status).toBe(400);
    }
  });

  it("never serves a desktop recording as a missing browser track for an older recorder", async () => {
    const { home, seed, request } = await setup(false);
    const recorded = await seedSession({ home, minutes: 0.01 });
    const path = `/api/sessions/${recorded.sessionId}/recording`;
    expect((await request(`${path}/video.mp4`)).status).toBe(200);
    expect((await request(`${path}/video.mp4?screen=browser`)).status).toBe(404);
    expect(
      RecordingInfo.parse(await (await request(`${path}?screen=browser`)).json()).manifest.state,
    ).toBe("none");
    expect(
      (await request(`/api/sessions/${seed.sessionId}/recording/video.mp4?screen=browser`)).status,
    ).toBe(404);
  });
  it("streams validated NDJSON on request and retains the JSON-array API", async () => {
    const { log, seed, request } = await setup();
    const sessionId = seed.sessionId;
    const expected = log.read(sessionId);
    appendFileSync(
      log.logFile(sessionId),
      `${JSON.stringify({ ...expected.at(-1), seq: 999, extraField: "discard-me" })}\n{"torn":`,
    );
    const response = await request(`/api/sessions/${sessionId}/events?fromSeq=1`, {
      headers: { accept: "application/x-ndjson" },
    });
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain("discard-me");
    const events = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as LocalDotEvent);
    expect(events[0]?.seq).toBe(1);
    expect(events.at(-1)?.seq).toBe(999);
    const legacy = await request(`/api/sessions/${sessionId}/events`);
    expect(await legacy.json()).toHaveLength(expected.length + 1);
  });

  it("keeps a live video snapshot unchanged while later fragments commit", async () => {
    const { home, log, request, liveIds, liveWriters } = await setup();
    const sessionId = log.createSession("Live video");
    const writer = new RecordingWriter({
      dir: join(home, "sessions", sessionId, "recording"),
      codec: SYNTH_CODEC,
      width: 64,
      height: 64,
    });
    writers.push(writer);
    liveIds.add(sessionId);
    liveWriters.set(sessionId, writer);
    await writer.start();
    const options = { widthMbs: 4, heightMbs: 4, keyEvery: 4 };
    for (let frameIndex = 0; frameIndex < 14; frameIndex++)
      await writer.push({
        ...synthFrame(options, frameIndex),
        tMicros: 1_000_000 + frameIndex * 16667,
      });
    expect(writer.entries).toHaveLength(3);
    const path = `/api/sessions/${sessionId}/recording/video.mp4`;
    expect((await request(path)).status).toBe(400);
    expect((await request(`${path}?upto=4`)).status).toBe(400);
    const before = new Uint8Array(await (await request(`${path}?upto=3`)).arrayBuffer());
    for (let frameIndex = 14; frameIndex < 22; frameIndex++)
      await writer.push({
        ...synthFrame(options, frameIndex),
        tMicros: 1_000_000 + frameIndex * 16667,
      });
    expect(new Uint8Array(await (await request(`${path}?upto=3`)).arrayBuffer())).toEqual(before);
    expect((await (await request(`${path}?upto=4`)).arrayBuffer()).byteLength).toBeGreaterThan(
      before.length,
    );
  });

  it("refuses deletion while either recorder or live-session controller owns the session", async () => {
    const { home, seed, request, liveIds, controlledIds } = await setup();
    const path = `/api/sessions/${seed.sessionId}`;
    liveIds.add(seed.sessionId);
    expect((await request(path, { method: "DELETE" })).status).toBe(409);
    liveIds.clear();
    controlledIds.add(seed.sessionId);
    expect((await request(path, { method: "DELETE" })).status).toBe(409);
    controlledIds.clear();
    expect((await request(path, { method: "DELETE" })).status).toBe(204);
    expect(existsSync(join(home, "sessions", seed.sessionId))).toBe(false);
    expect((await request(`${path}/card`)).status).toBe(404);
    expect(
      SessionIndexPage.parse(await (await request("/api/session-index")).json()).sessions,
    ).toEqual([]);
  });

  it("returns no recording for a session without video and serves its history card", async () => {
    const { seed, request } = await setup();
    expect(await (await request(`/api/sessions/${seed.sessionId}/recording`)).json()).toEqual({
      manifest: emptyManifest("none"),
      live: false,
      upto: 0,
      servedBytes: 0,
    });
    expect((await request(`/api/sessions/${seed.sessionId}/recording/video.mp4`)).status).toBe(404);
    expect(await (await request(`/api/sessions/${seed.sessionId}/card`)).json()).toMatchObject({
      id: seed.sessionId,
      verdict: "done",
    });
  });
});
