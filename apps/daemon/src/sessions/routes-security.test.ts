import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { monotonicClock } from "../clock.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { Recorder } from "../recorder/recorder.ts";
import { seedSession } from "../recorder/testing/seed-session.ts";
import { SessionIndex } from "./index-store.ts";
import { Thumbnails } from "./thumbs.ts";

const TOKEN = "p7-test-token-0123456789abcdefghijklmnopqrstu";
const PORT = 4790;
const url = (p: string) => `http://127.0.0.1:${PORT}${p}`;
const bearer = { authorization: `Bearer ${TOKEN}` };
let home: string;
let id: string;
let frameId: string;
let app: ReturnType<typeof createApp>;
let index: SessionIndex;
let log: EventLog | undefined;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "local dot's replay-routes-"));
  const seeded = await seedSession({ home, minutes: 1 });
  id = seeded.sessionId;
  const eventLog = new EventLog(home);
  log = eventLog;
  const recorder = new Recorder({
    home,
    eventLog,
    cells: { get: () => undefined, endpoints: () => undefined },
    clock: monotonicClock(),
  });
  index = new SessionIndex(home, { isLive: () => false });
  const frames = new FrameStore(home);
  const observe = eventLog.read(id).find((e) => e.type === "observe");
  frameId = observe?.type === "observe" ? observe.data.frameId : "";
  app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog,
    replay: { home, eventLog, recorder, index, thumbs: new Thumbnails(home, frames) },
  });
});
afterAll(() => {
  index?.close();
  log?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("replay routes: auth, ids and byte ranges", () => {
  const routes = () =>
    [
      ["GET", "/api/session-index"],
      ["GET", `/api/sessions/${id}/card`],
      ["GET", `/api/sessions/${id}/events`],
      ["GET", `/api/sessions/${id}/history`],
      ["GET", `/api/sessions/${id}/recording`],
      ["GET", `/api/sessions/${id}/recording/video.mp4`],
      ["HEAD", `/api/sessions/${id}/recording/video.mp4`],
      ["GET", `/api/sessions/${id}/thumbs/${frameId}`],
      ["DELETE", `/api/sessions/${id}`],
    ] as const;

  it("refuses every replay route without the install token or with a wrong one", async () => {
    for (const [method, path] of routes()) {
      for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }]) {
        const res = await app.request(url(path), {
          method,
          headers: { accept: "application/x-ndjson", ...headers },
        });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    }
  });

  it("refuses an id or frame id that is not a ULID before touching the filesystem", async () => {
    // "%2e%2e" and "%2e." never get here: the URL parser resolves them as dot segments (asserted below).
    const bad = ["..%2F..%2Fetc%2Fpasswd", `${id}%2F..`, id.toLowerCase(), `${id}x`, "%00"];
    for (const b of bad) {
      for (const path of [
        `/api/sessions/${b}/card`,
        `/api/sessions/${b}/events`,
        `/api/sessions/${b}/history`,
        `/api/sessions/${b}/recording`,
        `/api/sessions/${b}/recording/video.mp4`,
        `/api/sessions/${id}/thumbs/${b}`,
      ]) {
        const res = await app.request(url(path), { headers: bearer });
        expect(res.status, path).toBe(400);
      }
      expect(
        (await app.request(url(`/api/sessions/${b}`), { method: "DELETE", headers: bearer }))
          .status,
      ).toBe(400);
    }
    const dotted = await app.request(
      url(`/api/sessions/${id}/thumbs/%2e%2e/%2e%2e/%2e%2e/events.jsonl`),
      { headers: bearer },
    );
    expect(dotted.status).toBe(404);
  });

  it("serves byte ranges inside the recording only", async () => {
    const full = await app.request(url(`/api/sessions/${id}/recording/video.mp4`), {
      headers: bearer,
    });
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    const bytes = new Uint8Array(await full.arrayBuffer());
    const size = bytes.length;
    expect(Number(full.headers.get("content-length"))).toBe(size);
    const range = async (r: string) =>
      app.request(url(`/api/sessions/${id}/recording/video.mp4`), {
        headers: { ...bearer, range: r },
      });
    const head = await range("bytes=0-15");
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe(`bytes 0-15/${size}`);
    expect(new Uint8Array(await head.arrayBuffer())).toEqual(bytes.subarray(0, 16));
    const tail = await range("bytes=-16");
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.subarray(size - 16));
    const open = await range(`bytes=${size - 10}-`);
    expect(open.headers.get("content-range")).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
    await open.arrayBuffer();
    for (const r of [
      `bytes=${size}-`,
      "bytes=5-2",
      "bytes=0-1,4-5",
      "items=0-1",
      "bytes=-0",
      "bytes=x-",
      "bytes=999999999999999999999-",
      "bytes=-999999999999999999999",
    ]) {
      const res = await range(r);
      expect(res.status, r).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${size}`);
    }
    const emptyHead = await app.request(url(`/api/sessions/${id}/recording/video.mp4`), {
      method: "HEAD",
      headers: bearer,
    });
    expect(emptyHead.status).toBe(200);
    expect(emptyHead.headers.get("content-length")).toBe(String(size));
    expect((await emptyHead.arrayBuffer()).byteLength).toBe(0);
    for (const q of ["upto=abc", "upto=-1", "upto=1.5"]) {
      expect(
        (
          await app.request(url(`/api/sessions/${id}/recording/video.mp4?${q}`), {
            headers: bearer,
          })
        ).status,
        q,
      ).toBe(400);
    }
  });

  it("never names the session's title, home or token in an error body", async () => {
    const res = await app.request(url("/api/sessions/01J9ZQ3V8Y7X6W5T4S3R2Q1P0N/card"), {
      headers: bearer,
    });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain(home);
    expect(body).not.toContain(TOKEN);
  });
});
