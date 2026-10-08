import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { monotonicClock } from "../clock.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { Recorder } from "../recorder/recorder.ts";
import { seedSession } from "../recorder/testing/seed-session.ts";
import { SessionIndex } from "./index-store.ts";
import { Thumbnails } from "./thumbs.ts";

const viewOwners = vi.hoisted(() => [] as { closes: number; close(): void }[]);
vi.mock("../recorder/view.ts", async (original) => {
  const actual = await original<typeof import("../recorder/view.ts")>();
  return {
    ...actual,
    openRecordingView: (...args: Parameters<typeof actual.openRecordingView>) => {
      const view = actual.openRecordingView(...args);
      const owner = { closes: 0, close: () => view.close() };
      viewOwners.push(owner);
      return {
        ...view,
        close() {
          owner.closes++;
          view.close();
        },
      };
    },
  };
});
const TOKEN = "fixture-only-review-install-token";
const homes: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const owner of viewOwners.splice(0)) owner.close();
  for (const close of closers.splice(0)) close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "review-replay-boundary-"));
  homes.push(home);
  const { sessionId: id } = await seedSession({ home, minutes: 0.1 });
  const log = new EventLog(home);
  const index = new SessionIndex(home, { isLive: () => false });
  closers.push(
    () => index.close(),
    () => log.close(),
  );
  const recorder = new Recorder({
    home,
    eventLog: log,
    cells: { get: () => undefined, endpoints: () => undefined },
    clock: monotonicClock(),
  });
  let live = false;
  let held = false;
  const info = vi.fn((session: string) => {
    const value = recorder.info(session);
    return value && { ...value, live };
  });
  const card = vi.spyOn(index, "card");
  const thumbs = new Thumbnails(home, new FrameStore(home));
  const thumb = vi.spyOn(thumbs, "path");
  const app = createApp({
    token: TOKEN,
    port: 4790,
    eventLog: log,
    replay: {
      home,
      eventLog: log,
      index,
      recorder: { info, isLive: () => live },
      live: { cellOf: () => (held ? "fixture-cell" : undefined) },
      thumbs,
    },
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(`http://127.0.0.1:4790${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
    });
  const video = `/api/sessions/${id}/recording/video.mp4`;
  const file = join(home, "sessions", id, "recording", "video.mp4");
  return {
    request,
    id,
    video,
    file,
    log,
    info,
    card,
    thumb,
    setLive: (value: boolean) => {
      live = value;
    },
    setHeld: (value: boolean) => {
      held = value;
    },
  };
}
describe("review: replay authorization and bounded video ownership", () => {
  it("wrong-token and untrusted-origin requests never enter storage operations", async () => {
    const x = await setup();
    const before = readFileSync(x.file);
    const routes = [
      ["GET", "/api/session-index"],
      ["GET", `/api/sessions/${x.id}/card`],
      ["GET", `/api/sessions/${x.id}/recording`],
      ["GET", x.video],
      ["HEAD", x.video],
      ["DELETE", `/api/sessions/${x.id}`],
    ];
    for (const [method, path] of routes) {
      expect(
        (await x.request(path!, { method, headers: { authorization: "Bearer wrong" } })).status,
      ).toBe(401);
      expect(
        (await x.request(path!, { method, headers: { origin: "https://untrusted.example" } }))
          .status,
      ).toBe(403);
    }
    expect(x.info).not.toHaveBeenCalled();
    expect(x.card).not.toHaveBeenCalled();
    expect(x.thumb).not.toHaveBeenCalled();
    expect(viewOwners).toHaveLength(0);
    expect(x.log.hasSession(x.id)).toBe(true);
    expect(readFileSync(x.file)).toEqual(before);
  });
  it("both live recorder and held session refuse deletion without losing media", async () => {
    const x = await setup();
    const before = readFileSync(x.file);
    for (const owner of ["live", "held"] as const) {
      x.setLive(owner === "live");
      x.setHeld(owner === "held");
      const response = await x.request(`/api/sessions/${x.id}`, { method: "DELETE" });
      expect(x.log.hasSession(x.id), `${owner} ownership preserves the session files`).toBe(true);
      expect(readFileSync(x.file)).toEqual(before);
      expect(response.status).toBe(409);
    }
    x.setLive(false);
    x.setHeld(false);
    expect((await x.request(`/api/sessions/${x.id}`, { method: "DELETE" })).status).toBe(204);
    expect(x.log.hasSession(x.id)).toBe(false);
  });
  it("HEAD, invalid ranges, consumed ranges, cancellation and abort close every owned video view once", async () => {
    const x = await setup();
    expect((await x.request(x.video, { method: "HEAD" })).body).toBeNull();
    expect(viewOwners.at(-1)?.closes).toBe(1);
    expect((await x.request(x.video, { headers: { range: "bytes=0-2,4-9" } })).status).toBe(416);
    expect(viewOwners.at(-1)?.closes).toBe(1);
    const response = await x.request(x.video, { headers: { range: "bytes=1-20" } });
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(x.file).subarray(1, 21));
    expect(viewOwners.at(-1)?.closes).toBe(1);
    const cancel = await x.request(x.video);
    await cancel.body!.cancel();
    expect(viewOwners.at(-1)?.closes).toBe(1);
    const controller = new AbortController();
    const aborted = await x.request(x.video, { signal: controller.signal });
    controller.abort();
    await expect(aborted.arrayBuffer()).rejects.toThrow("request aborted");
    expect(viewOwners).toHaveLength(5);
    expect(viewOwners.every((owner) => owner.closes === 1)).toBe(true);
  });
  it("live requests reject absent, fractional, unsafe and uncommitted snapshot counts before a view opens", async () => {
    const x = await setup();
    x.setLive(true);
    for (const suffix of ["", "?upto=1.5", "?upto=9007199254740992", "?upto=999"])
      expect((await x.request(x.video + suffix)).status).toBe(400);
    expect(viewOwners).toHaveLength(0);
    const response = await x.request(`${x.video}?upto=1`);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(viewOwners).toHaveLength(1);
    expect(viewOwners[0]?.closes).toBe(1);
  });
});
