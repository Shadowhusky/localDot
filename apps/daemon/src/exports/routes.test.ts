import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExportsState, type HostExport, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { StatusSocket } from "../cells/status-stream.ts";
import type { EventLog } from "../event-log.ts";
import { ExportJobs } from "./jobs.ts";
import { ExportLinks, followExports } from "./routes.ts";
import { ExportStore } from "./store.ts";
import { FakeRenderer } from "./testing/fake-renderer.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const ORIGIN = "http://127.0.0.1:4747";
const AUTH = { authorization: "Bearer fixture" };
const START = {
  screen: "desktop",
  request: {
    sessionId: ulid(),
    fromMs: 0,
    toMs: 60_000,
    speed: 2,
    skipIdle: true,
    captions: true,
    overlays: true,
    size: { w: 1280, h: 800 },
    fps: 15,
    quality: "low",
    format: "mp4",
  },
};

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "export-routes-"));
  homes.push(home);
  const renderer = new FakeRenderer();
  const store = new ExportStore(home);
  const jobs = new ExportJobs({ store, renderer });
  await jobs.check();
  const app = createApp({ token: "fixture", port: 4747, eventLog: {} as EventLog, exports: jobs });
  const call = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init);
  const start = async () => {
    const response = await call("/api/exports", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(START),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as HostExport;
  };
  const finished = async (bytes: Uint8Array) => {
    const job = await start();
    const rendering = await renderer.next();
    await rendering.io.write(0, bytes);
    rendering.finish(450);
    await vi.waitFor(() => {
      if (jobs.file(job.id) === undefined) throw new Error("not yet");
    });
    return job;
  };
  return { app, call, jobs, store, renderer, start, finished };
}

describe("export routes", () => {
  it("need the install token", async () => {
    const { call } = await fixture();
    expect((await call("/api/exports")).status).toBe(401);
    expect((await call("/api/exports", { method: "POST", body: "{}" })).status).toBe(401);
    const listed = await call("/api/exports", { headers: AUTH });
    expect(((await listed.json()) as ExportsState).host.state).toBe("ready");
  });

  it("refuse a malformed export", async () => {
    const { call } = await fixture();
    const response = await call("/api/exports", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ ...START, request: { ...START.request, speed: 99 } }),
    });
    expect(response.status).toBe(400);
  });

  // The page that asked for the video is gone (a phone locked, the app switched away): the host
  // makes it all the same, and anyone signed in can save it afterwards.
  it("keep making a video with nobody watching", async () => {
    const { call, renderer, start } = await fixture();
    const job = await start();
    const rendering = await renderer.next();
    await rendering.io.write(0, new Uint8Array([7, 7, 7]));
    rendering.finish(450);
    await vi.waitFor(async () => {
      const state = (await (await call("/api/exports", { headers: AUTH })).json()) as ExportsState;
      expect(state.exports[0]).toMatchObject({ id: job.id, phase: "done", bytes: 3 });
    });
  });

  it("hand out a download link that needs no token", async () => {
    const { call, finished } = await fixture();
    const job = await finished(new Uint8Array([1, 2, 3]));
    expect((await call(`/api/exports/${job.id}/link`, { method: "POST" })).status).toBe(401);
    const linked = await call(`/api/exports/${job.id}/link`, { method: "POST", headers: AUTH });
    const { href } = (await linked.json()) as { href: string };
    expect(href).toMatch(/^\/export-files\/[A-Za-z0-9_-]{43}$/);
    const file = await call(href);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("video/mp4");
    expect(file.headers.get("content-disposition")).toBe(
      `attachment; filename="${job.name}"; filename*=UTF-8''${job.name}`,
    );
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const direct = await call(`/api/exports/${job.id}/file`, { headers: AUTH });
    expect(direct.status).toBe(200);
  });

  it("refuse unknown, malformed and stale links", async () => {
    const { call, finished } = await fixture();
    const job = await finished(new Uint8Array([1]));
    for (const path of [
      `/export-files/${"A".repeat(43)}`,
      "/export-files/..%2Fexports.json",
      "/export-files/short",
    ])
      expect((await call(path)).status).toBe(404);
    let now = 0;
    const links = new ExportLinks(() => now);
    const ticket = links.issue(job.id);
    expect(links.resolve(ticket)).toBe(job.id);
    now += 10 * 60 * 1000;
    expect(links.resolve(ticket)).toBeUndefined();
  });

  it("serve nothing outside the exports folder", async () => {
    const { call, store, finished } = await fixture();
    const job = await finished(new Uint8Array([1]));
    for (const path of [
      "/api/exports/..%2F..%2Fdaemon-token/file",
      "/api/exports/%2E%2E/file",
      `/api/exports/${ulid()}/file`,
    ])
      expect((await call(path, { headers: AUTH })).status).toBe(404);
    expect(
      (await call(`/api/exports/${job.id}/link`, { method: "POST", headers: AUTH })).status,
    ).toBe(200);
    const secret = join(store.dir, "..", "secret.txt");
    writeFileSync(secret, "secret");
    rmSync(store.file(job));
    symlinkSync(secret, store.file(job));
    expect((await call(`/api/exports/${job.id}/file`, { headers: AUTH })).status).toBe(404);
  });

  it("cancel, retry and remove", async () => {
    const { call, renderer, start, store, finished } = await fixture();
    const running = await start();
    const rendering = await renderer.next();
    expect(
      (await call(`/api/exports/${running.id}/cancel`, { method: "POST", headers: AUTH })).status,
    ).toBe(204);
    expect(rendering.signal.aborted).toBe(true);
    expect(
      (await call(`/api/exports/${ulid()}/retry`, { method: "POST", headers: AUTH })).status,
    ).toBe(404);
    await vi.waitFor(() => {
      if (renderer.renders.some((entry) => !entry.settled)) throw new Error("not yet");
    });
    const job = await finished(new Uint8Array([1]));
    expect(
      (await call(`/api/exports/${job.id}/retry`, { method: "POST", headers: AUTH })).status,
    ).toBe(409);
    expect((await call(`/api/exports/${job.id}`, { method: "DELETE", headers: AUTH })).status).toBe(
      204,
    );
    expect(store.get(job.id)).toBeUndefined();
    expect(
      (await call(`/api/exports/${job.id}/link`, { method: "POST", headers: AUTH })).status,
    ).toBe(404);
  });

  it("check the host before the first video, even with no page listing first", async () => {
    const home = mkdtempSync(join(tmpdir(), "export-routes-"));
    homes.push(home);
    const renderer = new FakeRenderer();
    const jobs = new ExportJobs({ store: new ExportStore(home), renderer });
    const app = createApp({
      token: "fixture",
      port: 4747,
      eventLog: {} as EventLog,
      exports: jobs,
    });
    const response = await app.request(`${ORIGIN}/api/exports`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(START),
    });
    expect(response.status).toBe(201);
    expect(renderer.checks).toBe(1);
  });

  it("refuse to start while the host can't make videos", async () => {
    const home = mkdtempSync(join(tmpdir(), "export-routes-"));
    homes.push(home);
    const renderer = new FakeRenderer();
    renderer.able = null;
    const jobs = new ExportJobs({ store: new ExportStore(home), renderer });
    await jobs.check();
    const app = createApp({
      token: "fixture",
      port: 4747,
      eventLog: {} as EventLog,
      exports: jobs,
    });
    const response = await app.request(`${ORIGIN}/api/exports`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(START),
    });
    expect(response.status).toBe(503);
  });
});

describe("the exports stream", () => {
  it("sends every viewer the whole list, then each change", async () => {
    const { jobs, start } = await fixture();
    const sent: ExportsState[] = [];
    const handlers = new Map<string, () => void>();
    const socket: StatusSocket = {
      bufferedAmount: 0,
      send: (data) => sent.push(JSON.parse(data)),
      close() {},
      terminate() {},
      on: (event, listener) => void handlers.set(event, listener),
    };
    followExports(socket, jobs);
    expect(sent[0]?.exports).toEqual([]);
    const job = await start();
    expect(sent.at(-1)?.exports[0]?.id).toBe(job.id);
    handlers.get("close")?.();
    const count = sent.length;
    jobs.cancel(job.id);
    expect(sent).toHaveLength(count);
  });

  it("cuts off a viewer that falls behind", async () => {
    const { jobs } = await fixture();
    const terminate = vi.fn();
    followExports(
      { bufferedAmount: 2 * 1024 * 1024, send() {}, close() {}, terminate, on() {} },
      jobs,
    );
    expect(terminate).toHaveBeenCalled();
  });
});
