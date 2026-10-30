import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteSessionsResult,
  emptyManifest,
  type LocalDotEvent,
  RecordingInfo,
  SessionIndexPage,
  ulid,
} from "@localdot/protocol";
import { SYNTH_CODEC, synthFrame } from "@localdot/stage/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Conversations } from "../agent/conversation.ts";
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
  vi.restoreAllMocks();
  for (const writer of writers.splice(0)) writer.close();
  for (const index of indexes.splice(0)) index.close();
  for (const log of logs.splice(0)) log.close();
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("replay APIs", () => {
  it("deletes the full conversation, preflights live tasks and clears the selected conversation", async () => {
    const f = await setup();
    const task = (continues?: string) => {
      const id = f.log.createSession("test conversation");
      f.log.append(id, {
        type: "session.start",
        agent: "main",
        data: {
          screen: { w: 1280, h: 800, scale: 1 },
          os: "linux",
          title: "test conversation",
          ...(continues ? { continues } : {}),
        },
      });
      f.log.append(id, {
        type: "message.user",
        agent: "main",
        data: { messageId: ulid(), text: "task", kind: "task" },
      });
      return id;
    };
    const first = task(),
      latest = task(first);
    const conversations = new Conversations(f.home, f.log);
    conversations.adopt(latest);
    f.controlledIds.add(first);
    expect((await f.request(`/api/conversations/${latest}`, { method: "DELETE" })).status).toBe(
      409,
    );
    expect(f.log.hasSession(first)).toBe(true);
    expect(f.log.hasSession(latest)).toBe(true);
    f.controlledIds.clear();
    expect((await f.request(`/api/conversations/${latest}`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect(f.log.hasSession(first)).toBe(false);
    expect(f.log.hasSession(latest)).toBe(false);
    expect(conversations.current()).toBeNull();
    expect(f.log.hasSession(f.seed.sessionId)).toBe(true);
  });
  it("renames a whole conversation by any of its tasks, and gives it back its automatic name", async () => {
    const f = await setup();
    const task = (continues?: string) => {
      const id = f.log.createSession("plan the trip");
      f.log.append(id, {
        type: "session.start",
        agent: "main",
        data: {
          screen: { w: 1280, h: 800, scale: 1 },
          os: "linux",
          title: "plan the trip",
          ...(continues ? { continues } : {}),
        },
      });
      f.log.append(id, {
        type: "message.user",
        agent: "main",
        data: { messageId: ulid(), text: "plan the trip", kind: "task" },
      });
      return id;
    };
    const first = task(),
      latest = task(first);
    f.log.append(first, {
      type: "session.title",
      agent: "main",
      data: { title: "Lisbon weekend", by: "auto" },
    });
    const rename = (id: string, body: unknown) =>
      f.request(`/api/conversations/${id}/title`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const titles = () => [first, latest].map((id) => f.log.sessionInfo([id]).get(id)?.title);
    const card = async (id: string) =>
      ((await (await f.request(`/api/sessions/${id}/card`)).json()) as { title: string }).title;

    expect((await rename(first, { title: "  Mum's 60th in Lisbon " })).status).toBe(204);
    expect(titles()).toEqual(["Mum's 60th in Lisbon", "Mum's 60th in Lisbon"]);
    expect(await card(first)).toBe("Mum's 60th in Lisbon");
    expect(new Conversations(f.home, f.log).list()[0]?.title).toBe("Mum's 60th in Lisbon");
    // The same name again records nothing new; dot's later name never takes over.
    const events = f.log.read(latest).length;
    expect((await rename(latest, { title: "Mum's 60th in Lisbon" })).status).toBe(204);
    expect(f.log.read(latest)).toHaveLength(events);
    f.log.append(first, {
      type: "session.title",
      agent: "main",
      data: { title: "Lisbon city break", by: "auto" },
    });
    expect(titles()[0]).toBe("Mum's 60th in Lisbon");

    expect((await rename(latest, { title: null })).status).toBe(204);
    expect(titles()).toEqual(["Lisbon city break", "plan the trip"]);
    expect(await card(first)).toBe("Lisbon city break");

    for (const body of [
      {},
      { title: "" },
      { title: "   " },
      { title: "x".repeat(81) },
      { title: "two\nlines" },
      { title: "bell\u0007" },
      { title: 4 },
      { title: "ok", extra: true },
    ])
      expect((await rename(latest, body)).status).toBe(400);
    expect((await rename(latest, { title: "x".repeat(80) })).status).toBe(204);
    // The user's own time on the computer keeps its own name in Replay.
    const hold = f.log.createSession("You used the computer");
    f.log.append(hold, {
      type: "session.start",
      agent: "main",
      data: { screen: { w: 1280, h: 800, scale: 1 }, os: "linux", continues: latest },
    });
    expect((await rename(hold, { title: "Lisbon" })).status).toBe(204);
    expect(titles()).toEqual(["Lisbon", "Lisbon"]);
    expect(f.log.sessionInfo([hold]).get(hold)?.title).toBe("You used the computer");
    expect((await rename(ulid(), { title: "Nowhere" })).status).toBe(404);
    expect((await rename("not-a-task", { title: "Nowhere" })).status).toBe(404);
  });
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
      // A reader names the size it opened, so a video compaction replaced is refused, not mixed.
      const opened = `${base}/video.mp4?screen=${screen}&bytes=`;
      expect(
        (await request(`${opened}${info.servedBytes}`, { headers: { range: "bytes=20-95" } }))
          .status,
      ).toBe(206);
      expect((await request(`${opened}${info.servedBytes + 1}`)).status).toBe(409);
      expect((await request(`${opened}-1`)).status).toBe(400);
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

  it("serves a task's history without the model's thinking or the heartbeats", async () => {
    const { log, request } = await setup();
    const sessionId = log.createSession("History");
    log.append(sessionId, {
      agent: "main",
      type: "message.user",
      data: { messageId: ulid(), text: "Draw a dog", kind: "task" },
    });
    log.append(sessionId, { agent: "main", type: "thought.delta", data: { text: "Let me look" } });
    log.append(sessionId, {
      agent: "main",
      type: "heartbeat",
      data: { ongoing: true, everyMs: 1000 },
    });
    log.append(sessionId, {
      agent: "main",
      type: "message.assistant",
      data: { messageId: ulid(), text: "Drew it." },
    });
    const response = await request(`/api/sessions/${sessionId}/history`);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as LocalDotEvent);
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [0, "message.user"],
      [3, "message.assistant"],
    ]);
    expect((await request(`/api/sessions/${ulid()}/history`)).status).toBe(404);
    expect((await request("/api/sessions/nope/history")).status).toBe(400);
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

  it("deletes many tasks at once, keeps running ones and counts a repeat as done", async () => {
    const { home, seed, log, request, liveIds, controlledIds } = await setup();
    const ended = [log.createSession("first"), log.createSession("second")];
    const recording = log.createSession("recording");
    const controlled = log.createSession("controlled");
    liveIds.add(recording);
    controlledIds.add(controlled);
    const remove = (ids: string[]) =>
      request("/api/session-index/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
    const first = await remove([...ended, recording, controlled, seed.sessionId, ended[0] ?? ""]);
    expect(first.status).toBe(200);
    expect(DeleteSessionsResult.parse(await first.json())).toEqual({
      deleted: [...ended, seed.sessionId],
      live: [recording, controlled],
      failed: [],
    });
    for (const id of [...ended, seed.sessionId]) {
      expect(log.hasSession(id)).toBe(false);
      expect(existsSync(join(home, "sessions", id))).toBe(false);
    }
    expect(log.hasSession(recording)).toBe(true);
    expect(log.hasSession(controlled)).toBe(true);
    expect(
      SessionIndexPage.parse(await (await request("/api/session-index")).json())
        .sessions.map((card) => card.id)
        .sort(),
    ).toEqual([recording, controlled].sort());
    expect(await (await remove(ended)).json()).toEqual({ deleted: ended, live: [], failed: [] });
  });

  it("reports a task it couldn't delete and still deletes the rest", async () => {
    const { seed, log, request } = await setup();
    const stuck = log.createSession("stuck");
    const forget = log.forget.bind(log);
    vi.spyOn(log, "forget").mockImplementation((id) => {
      if (id === stuck) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      forget(id);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const reply = await request("/api/session-index/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [stuck, seed.sessionId] }),
    });
    expect(await reply.json()).toEqual({ deleted: [seed.sessionId], live: [], failed: [stuck] });
    expect(log.hasSession(stuck)).toBe(true);
    expect(log.hasSession(seed.sessionId)).toBe(false);
    expect(logged).toHaveBeenCalledWith("deleting a task failed (EBUSY)");
  });

  it("refuses a bulk delete that names anything but up to 100 task ids", async () => {
    const { home, seed, log, request } = await setup();
    const post = (body: string) =>
      request("/api/session-index/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    for (const body of [
      "not json",
      "{}",
      JSON.stringify({ ids: [] }),
      JSON.stringify({ ids: [seed.sessionId, "../../daemon-token"] }),
      JSON.stringify({ ids: [seed.sessionId, ".deleting"] }),
      JSON.stringify({ ids: [seed.sessionId.toLowerCase()] }),
      JSON.stringify({ ids: seed.sessionId }),
      JSON.stringify({ ids: [seed.sessionId], all: true }),
      JSON.stringify({ ids: Array.from({ length: 101 }, () => ulid()) }),
    ])
      expect((await post(body)).status, body.slice(0, 40)).toBe(400);
    const padded = JSON.stringify({ ids: [seed.sessionId], pad: "x".repeat(9000) });
    expect((await post(padded)).status).toBe(413);
    expect(log.hasSession(seed.sessionId)).toBe(true);
    expect(existsSync(join(home, "sessions", seed.sessionId))).toBe(true);
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
