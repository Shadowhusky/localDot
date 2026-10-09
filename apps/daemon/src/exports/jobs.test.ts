import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExportRequest, type ExportsState, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportJobs, ExportRefused, exportName, NO_RENDERER } from "./jobs.ts";
import { DEFAULT_EXPORT_LIMITS, ExportStore, INTERRUPTED } from "./store.ts";
import { FakeRenderer } from "./testing/fake-renderer.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const SESSION = ulid();
const request = (patch: Partial<ExportRequest> = {}): ExportRequest => ({
  sessionId: SESSION,
  fromMs: 0,
  toMs: 60_000,
  speed: 1,
  skipIdle: false,
  captions: true,
  overlays: true,
  size: { w: 1280, h: 800 },
  fps: 30,
  quality: "high",
  format: "mp4",
  ...patch,
});

async function fixture(options: { home?: string; maxBytes?: number } = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "exports-"));
  if (!options.home) homes.push(home);
  const renderer = new FakeRenderer();
  let clock = 0;
  const store = new ExportStore(home, {
    ...DEFAULT_EXPORT_LIMITS,
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  });
  const jobs = new ExportJobs({
    store,
    renderer,
    now: () => Date.parse("2026-10-09T14:05:00Z") + clock,
    clock: () => clock,
  });
  const states: ExportsState[] = [];
  jobs.subscribe((state) => states.push(state));
  await jobs.check();
  return {
    home,
    store,
    jobs,
    renderer,
    states,
    tick(ms: number) {
      clock += ms;
    },
  };
}

const until = (check: () => boolean) =>
  vi.waitFor(() => {
    if (!check()) throw new Error("not yet");
  });
const phase = (jobs: ExportJobs, id: string) =>
  jobs.state().exports.find((entry) => entry.id === id)?.phase;

describe("ExportJobs", () => {
  it("makes a video on the host: queued, making with progress and time left, then done", async () => {
    const { jobs, renderer, store, tick } = await fixture();
    const job = jobs.start({ request: request(), screen: "desktop" });
    expect(job.phase).toBe("making");
    const rendering = await renderer.next();
    expect(rendering.job.id).toBe(job.id);
    await rendering.io.write(0, new Uint8Array([1, 2, 3, 4]));
    tick(2000);
    rendering.io.progress(450, 1800);
    const making = jobs.state().exports[0];
    expect(making).toMatchObject({ phase: "making", done: 450, total: 1800, bytes: 4 });
    expect(making?.elapsedMs).toBe(2000);
    expect(making?.leftMs).toBe(6000);
    await rendering.io.write(4, new Uint8Array([5, 6]));
    rendering.finish(1800);
    await until(() => phase(jobs, job.id) === "done");
    const done = jobs.state().exports[0];
    expect(done).toMatchObject({ phase: "done", done: 1800, total: 1800, bytes: 6, durationS: 60 });
    expect(readFileSync(store.file(done ?? job))).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
    expect(existsSync(store.partFile(job))).toBe(false);
  });

  it("is refused while the host cannot make videos, and checks the host only once", async () => {
    const home = mkdtempSync(join(tmpdir(), "exports-"));
    homes.push(home);
    const renderer = new FakeRenderer();
    renderer.able = null;
    const jobs = new ExportJobs({ store: new ExportStore(home), renderer });
    expect(() => jobs.start({ request: request(), screen: "desktop" })).toThrow(NO_RENDERER);
    await Promise.all([jobs.check(), jobs.check()]);
    await jobs.check();
    expect(renderer.checks).toBe(1);
    expect(jobs.state().host.state).toBe("unavailable");
    expect(() => jobs.start({ request: request(), screen: "desktop" })).toThrow(ExportRefused);
  });

  it("refuses a picture larger than the host can encode", async () => {
    const home = mkdtempSync(join(tmpdir(), "exports-"));
    homes.push(home);
    const renderer = new FakeRenderer();
    renderer.able = { maxPixels: { mp4: 1280 * 800, webm: 0 }, decodes: true, graphics: "x" };
    const jobs = new ExportJobs({ store: new ExportStore(home), renderer });
    await jobs.check();
    expect(() =>
      jobs.start({ request: request({ size: { w: 2560, h: 1600 } }), screen: "desktop" }),
    ).toThrow(/can't make video that large/);
    expect(() => jobs.start({ request: request({ format: "webm" }), screen: "desktop" })).toThrow(
      /can't make video that large/,
    );
    expect(jobs.state().exports).toHaveLength(0);
  });

  it("makes one video at a time, oldest first", async () => {
    const { jobs, renderer } = await fixture();
    const first = jobs.start({ request: request(), screen: "desktop" });
    const second = jobs.start({ request: request(), screen: "browser" });
    expect(jobs.state().exports.map((entry) => [entry.id, entry.phase])).toEqual([
      [second.id, "queued"],
      [first.id, "making"],
    ]);
    expect(second.name).toMatch(/-browser\.mp4$/);
    (await renderer.next()).finish(10);
    await until(() => phase(jobs, second.id) === "making");
    expect((await renderer.next()).job.id).toBe(second.id);
  });

  it("cancels a video being made and leaves nothing behind", async () => {
    const { jobs, renderer, store } = await fixture();
    const job = jobs.start({ request: request(), screen: "desktop" });
    const rendering = await renderer.next();
    await rendering.io.write(0, new Uint8Array(8));
    expect(existsSync(store.partFile(job))).toBe(true);
    jobs.cancel(job.id);
    expect(rendering.signal.aborted).toBe(true);
    await until(() => jobs.state().exports.length === 0);
    expect(jobs.state().exports).toEqual([]);
    expect(existsSync(store.partFile(job))).toBe(false);
    expect(existsSync(store.file(job))).toBe(false);
  });

  it("cancels a waiting video without starting it", async () => {
    const { jobs, renderer } = await fixture();
    jobs.start({ request: request(), screen: "desktop" });
    const waiting = jobs.start({ request: request(), screen: "desktop" });
    jobs.cancel(waiting.id);
    expect(jobs.state().exports.map((entry) => entry.id)).not.toContain(waiting.id);
    (await renderer.next()).finish(1);
    await until(() => jobs.state().exports.every((entry) => entry.phase === "done"));
    expect(renderer.renders).toHaveLength(1);
  });

  it("fails in plain words, then makes it again on retry", async () => {
    const { jobs, renderer, store } = await fixture();
    const job = jobs.start({ request: request(), screen: "desktop" });
    const first = await renderer.next();
    await first.io.write(0, new Uint8Array(4));
    first.fail("The recording could not be exported.");
    await until(() => phase(jobs, job.id) === "failed");
    expect(jobs.state().exports[0]).toMatchObject({
      phase: "failed",
      error: "The recording could not be exported.",
    });
    expect(existsSync(store.partFile(job))).toBe(false);
    expect(() => jobs.cancel(job.id)).toThrow(ExportRefused);
    const again = jobs.retry(job.id);
    expect(again.phase).toBe("making");
    (await renderer.next()).finish(30);
    await until(() => phase(jobs, job.id) === "done");
    expect(jobs.state().exports[0]).toMatchObject({ id: job.id, phase: "done", error: null });
  });

  it("says nothing about the inside of an unexpected failure", async () => {
    const { jobs, renderer } = await fixture();
    jobs.start({ request: request(), screen: "desktop" });
    (await renderer.next()).fail();
    await until(() => jobs.state().exports[0]?.phase === "failed");
    expect(jobs.state().exports[0]?.error).toBe("The video couldn't be made. Try again.");
  });

  it("stops a video that grows past the space kept for exports", async () => {
    const { jobs, renderer, store } = await fixture({ maxBytes: 10 });
    const job = jobs.start({ request: request(), screen: "desktop" });
    const rendering = await renderer.next();
    await rendering.io.write(0, new Uint8Array(8));
    await expect(rendering.io.write(8, new Uint8Array(8))).rejects.toThrow(/space kept/);
    expect(rendering.signal.aborted).toBe(true);
    await until(() => phase(jobs, job.id) === "failed");
    expect(jobs.state().exports[0]).toMatchObject({
      phase: "failed",
      error: "The video grew past the space kept for exports.",
    });
    expect(existsSync(store.partFile(job))).toBe(false);
  });

  it("marks a video interrupted by a restart failed, with a retry that works", async () => {
    const first = await fixture();
    const job = first.jobs.start({ request: request(), screen: "desktop" });
    const rendering = await first.renderer.next();
    await rendering.io.write(0, new Uint8Array(4));
    // The daemon stops without finishing: a new one opens the same home.
    const second = await fixture({ home: first.home });
    expect(second.jobs.state().exports[0]).toMatchObject({
      id: job.id,
      phase: "failed",
      error: INTERRUPTED,
    });
    expect(existsSync(second.store.partFile(job))).toBe(false);
    second.jobs.retry(job.id);
    (await second.renderer.next()).finish(2);
    await until(() => phase(second.jobs, job.id) === "done");
    expect(second.jobs.state().exports[0]?.phase).toBe("done");
  });

  it("calls a video the daemon stopped for shutting down interrupted, not broken", async () => {
    const { jobs, renderer } = await fixture();
    const job = jobs.start({ request: request(), screen: "desktop" });
    await renderer.next();
    jobs.close();
    await until(() => phase(jobs, job.id) === "failed");
    expect(jobs.state().exports[0]?.error).toBe(INTERRUPTED);
  });

  it("removes a finished video and its file", async () => {
    const { jobs, renderer, store } = await fixture();
    const job = jobs.start({ request: request(), screen: "desktop" });
    const rendering = await renderer.next();
    await rendering.io.write(0, new Uint8Array(4));
    rendering.finish(1);
    await until(() => phase(jobs, job.id) === "done");
    expect(jobs.file(job.id)?.path).toBe(store.file(job));
    jobs.remove(job.id);
    expect(existsSync(store.file(job))).toBe(false);
    expect(jobs.file(job.id)).toBeUndefined();
    expect(() => jobs.remove(job.id)).toThrow(ExportRefused);
  });

  it("tells viewers about each change of phase", async () => {
    const { jobs, renderer, states } = await fixture();
    jobs.start({ request: request(), screen: "desktop" });
    (await renderer.next()).finish(1);
    await until(() => jobs.state().exports[0]?.phase === "done");
    const phases = states.map((state) => state.exports[0]?.phase ?? null);
    expect(phases).toContain("making");
    expect(phases.at(-1)).toBe("done");
  });
});

describe("exportName", () => {
  it("names a video by when it was asked for, and never twice the same", () => {
    const at = new Date(2026, 9, 9, 15, 4);
    expect(exportName(at, "desktop", "mp4", new Set())).toBe("localdot-2026-10-09-1504.mp4");
    expect(exportName(at, "browser", "webm", new Set())).toBe(
      "localdot-2026-10-09-1504-browser.webm",
    );
    expect(
      exportName(
        at,
        "desktop",
        "mp4",
        new Set(["localdot-2026-10-09-1504.mp4", "localdot-2026-10-09-1504-2.mp4"]),
      ),
    ).toBe("localdot-2026-10-09-1504-3.mp4");
  });
});
