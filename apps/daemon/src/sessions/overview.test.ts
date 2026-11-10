import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OverviewReply, ulid } from "@localdot/protocol";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { RemoteLinks } from "../remote/links.ts";
import type { RemoteAccess } from "../remote/manager.ts";
import { SessionIndex } from "./index-store.ts";
import { OverviewTracker } from "./overview.ts";
import { Thumbnails } from "./thumbs.ts";

const token = "o".repeat(43);
const port = 4790;
const origin = `http://127.0.0.1:${port}`;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function setup(kept?: number) {
  const home = mkdtempSync(join(tmpdir(), "localdot-overview-"));
  const log = new EventLog(home);
  const index = new SessionIndex(home, { isLive: () => false });
  const cards: string[] = [];
  const overview = new OverviewTracker(
    log,
    (id) => {
      cards.push(id);
      return index.card(id);
    },
    kept,
  );
  const links = new RemoteLinks(home);
  cleanup.push(() => {
    overview.close();
    links.close();
    index.close();
    log.close();
    rmSync(home, { recursive: true, force: true });
  });
  const frames = new FrameStore(home);
  const app = createApp({
    token,
    port,
    eventLog: log,
    remoteAccess: {
      links,
      authenticate: (given?: string) => links.authenticate(given),
    } as unknown as RemoteAccess,
    replay: {
      home,
      eventLog: log,
      index,
      thumbs: new Thumbnails(home, frames),
      overview,
      recorder: { isLive: () => false, info: () => undefined },
    },
  });
  const append = (id: string, type: string, data: Record<string, unknown>, step?: string) =>
    log.append(id, { agent: "main", type, data, ...(step ? { step } : {}) } as never);
  const start = (title = "Plan the trip") => {
    const id = log.createSession(title);
    append(id, "session.start", { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title });
    return id;
  };
  const read = (path: string, init: { token?: string; headers?: Record<string, string> } = {}) =>
    app.request(`${origin}${path}`, {
      headers: { authorization: `Bearer ${init.token ?? token}`, ...init.headers },
    });
  const tiles = async (...ids: string[]) => {
    const response = await read(`/api/overview?ids=${ids.join(",")}`);
    expect(response.status).toBe(200);
    return OverviewReply.parse(await response.json()).tiles;
  };
  return { home, log, frames, overview, links, cards, append, start, read, tiles };
}

describe("the overview", () => {
  it("follows each task's latest screenshot, screen, steps and plan as its events are written", async () => {
    const f = setup();
    const id = f.start();
    expect(await f.tiles(id)).toEqual([{ sessionId: id, screen: "desktop", steps: 0 }]);
    f.append(id, "plan.set", {
      items: [
        { id: "read", text: "Read up on the districts", status: "doing" },
        { id: "fees", text: "Check hours and entry fees", status: "todo" },
        { id: "pdf", text: "Make the PDF", status: "todo" },
      ],
    });
    const step = ulid();
    f.append(id, "step.start", { kind: "browser", planItem: "read" }, step);
    const first = ulid();
    f.append(id, "observe", { frameId: first, width: 1280, height: 800 }, step);
    f.append(id, "plan.update", { id: "read", status: "done" });
    f.append(id, "plan.update", { id: "fees", status: "doing" });
    f.append(id, "step.start", { kind: "gui", planItem: "fees" }, ulid());
    f.append(id, "screen.switch", {
      screen: "browser",
      cellId: ulid(),
      geometry: { w: 1280, h: 800, scale: 2 },
      by: "agent",
      revision: 1,
    });
    const latest = ulid();
    f.append(id, "observe", { frameId: latest, width: 1280, height: 800 });
    expect(await f.tiles(id)).toEqual([
      {
        sessionId: id,
        frame: latest,
        screen: "browser",
        steps: 2,
        plan: { done: 1, total: 3, current: "Check hours and entry fees" },
      },
    ]);
    expect(f.cards).toEqual([]);
  });

  it("says what a task waits on the user for until it is answered", async () => {
    const f = setup();
    const id = f.start();
    const askId = ulid();
    f.append(id, "ask.request", {
      askId,
      question: "Friday or Saturday?",
      options: [],
      allowText: true,
    });
    expect((await f.tiles(id))[0]?.needs).toEqual({
      reason: "question",
      text: "Friday or Saturday?",
    });
    const requestId = ulid();
    f.append(id, "takeover.request", { requestId, reason: "login", note: "" });
    expect((await f.tiles(id))[0]?.needs).toEqual({ reason: "takeover", text: "Sign in" });
    f.append(id, "takeover.end", { requestId, by: "user" });
    f.append(id, "ask.answer", { askId, option: "A", by: "user" });
    expect((await f.tiles(id))[0]?.needs).toBeUndefined();
    const blockerId = ulid();
    f.append(id, "blocker.raise", {
      blockerId,
      blocker: { kind: "app", connector: "gmail", name: "Gmail", host: "gmail.com" },
      by: "localdot",
    });
    expect((await f.tiles(id))[0]?.needs).toEqual({ reason: "fix", text: "Connect Gmail again" });
    f.append(id, "session.end", { reason: "done" });
    expect((await f.tiles(id))[0]?.needs).toBeUndefined();
  });

  it("reads a task it never saw from its card once, then follows it", async () => {
    const f = setup();
    const id = f.log.createSession("Before the daemon started");
    const frame = ulid();
    f.log.append(id, {
      agent: "main",
      type: "session.start",
      data: { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux" },
    } as never);
    f.overview.forget(id);
    f.append(id, "step.start", { kind: "gui" }, ulid());
    f.append(id, "observe", { frameId: frame, width: 1280, height: 800 });
    f.overview.forget(id);
    expect(await f.tiles(id)).toEqual([{ sessionId: id, frame, steps: 1 }]);
    expect(await f.tiles(id)).toEqual([{ sessionId: id, frame, steps: 1 }]);
    expect(f.cards).toEqual([id]);
    f.append(id, "step.start", { kind: "gui" }, ulid());
    expect((await f.tiles(id))[0]?.steps).toBe(2);
  });

  it("keeps a bounded number of tasks, dropping the one heard from longest ago", async () => {
    const f = setup(2);
    const [a, b, c] = [f.start("a"), f.start("b"), f.start("c")];
    f.append(a, "step.start", { kind: "gui" }, ulid());
    expect(await f.tiles(b, c)).toHaveLength(2);
    expect(f.cards).toEqual([]);
    expect((await f.tiles(a))[0]?.steps).toBe(1);
    expect(f.cards).toEqual([a]);
  });

  it("answers only for tasks that exist, and says when nothing changed", async () => {
    const f = setup();
    const id = f.start();
    expect(await f.tiles(id, ulid(), id)).toHaveLength(1);
    expect((await f.read("/api/overview?ids=nope")).status).toBe(400);
    const tooMany = Array.from({ length: 51 }, () => ulid()).join(",");
    expect((await f.read(`/api/overview?ids=${tooMany}`)).status).toBe(400);
    expect(await (await f.read("/api/overview")).json()).toEqual({ tiles: [] });
    const first = await f.read(`/api/overview?ids=${id}`);
    const tag = first.headers.get("etag") ?? "";
    expect(first.headers.get("cache-control")).toBe("no-store");
    const same = await f.read(`/api/overview?ids=${id}`, { headers: { "if-none-match": tag } });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");
    f.append(id, "step.start", { kind: "gui" }, ulid());
    const moved = await f.read(`/api/overview?ids=${id}`, { headers: { "if-none-match": tag } });
    expect(moved.status).toBe(200);
    expect(moved.headers.get("etag")).not.toBe(tag);
  });

  it("is the owner's alone: a shared link's guest is refused, even for its own task", async () => {
    const f = setup();
    const { token: guest, grant } = f.links.create({
      label: "Guest",
      expiresInHours: null,
      maxTasks: 3,
      replay: true,
      model: { provider: "openai", model: "gpt-6.1-sol" },
    });
    const id = f.start();
    f.links.reserve(grant.id).finish(id);
    const response = await f.read(`/api/overview?ids=${id}`, { token: guest });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(id);
  });

  it("makes a thumbnail at a tile's width only from the widths it offers", async () => {
    const f = setup();
    const id = f.start();
    const frame = ulid();
    f.frames.save(
      id,
      frame,
      await sharp({ create: { width: 1280, height: 800, channels: 3, background: "teal" } })
        .webp()
        .toBuffer(),
    );
    const wide = await f.read(`/api/sessions/${id}/thumbs/${frame}?w=640`);
    expect(wide.status).toBe(200);
    expect(await sharp(Buffer.from(await wide.arrayBuffer())).metadata()).toMatchObject({
      width: 640,
      height: 400,
      format: "webp",
    });
    const strip = await f.read(`/api/sessions/${id}/thumbs/${frame}`);
    expect(await sharp(Buffer.from(await strip.arrayBuffer())).metadata()).toMatchObject({
      width: 320,
      height: 200,
    });
    for (const width of ["2560", "0", "640.0", "abc"])
      expect((await f.read(`/api/sessions/${id}/thumbs/${frame}?w=${width}`)).status).toBe(400);
  });
});
