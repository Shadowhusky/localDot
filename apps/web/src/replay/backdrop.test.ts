import { ulid } from "@localdot/protocol";
import { emptyModel } from "@localdot/stage";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplaySource } from "../stage/worker-protocol.ts";
import { BACKDROP_CACHE, ObserveBackdrop } from "./backdrop.ts";

const backdrops: ObserveBackdrop[] = [];
afterEach(() => {
  for (const backdrop of backdrops.splice(0)) backdrop.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(count = 1) {
  const source: ReplaySource = {
    sessionId: ulid(),
    origin: "http://127.0.0.1:4750",
    authorization: "Bearer synthetic-backdrop",
    video: null,
    gaps: [],
  };
  const model = {
    ...emptyModel(),
    observes: Array.from({ length: count }, (_, index) => ({
      t: index * 100 + 100,
      frameId: ulid(),
    })),
  };
  const images: { close: ReturnType<typeof vi.fn> }[] = [];
  const decode = vi.fn(async () => {
    const image = { close: vi.fn() };
    images.push(image);
    return image;
  });
  vi.stubGlobal("createImageBitmap", decode);
  vi.stubGlobal(
    "VideoFrame",
    class {
      timestamp: number;
      close = vi.fn();
      constructor(
        readonly image: unknown,
        options: VideoFrameInit,
      ) {
        this.timestamp = options.timestamp ?? 0;
      }
    },
  );
  const requests = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("synthetic pixels"));
  const backdrop = new ObserveBackdrop(source);
  backdrops.push(backdrop);
  return { source, model, images, decode, requests, backdrop };
}

describe("observation playback", () => {
  it("leaves a missing browser screenshot blank even when desktop screenshots are available", async () => {
    const fixture = setup(2);
    const browser = new ObserveBackdrop({ ...fixture.source, screen: "browser" });
    backdrops.push(browser);
    expect(await browser.frameAt(fixture.model, 500)).toBeNull();
    expect(fixture.requests).not.toHaveBeenCalled();
    fixture.model.observes.push({
      t: 400,
      frameId: ulid(),
      screen: "browser",
    } as (typeof fixture.model.observes)[number]);
    const frame = await browser.frameAt(fixture.model, 500);
    expect(frame).not.toBeNull();
    expect(String(fixture.requests.mock.calls[0]?.[0])).toContain(
      fixture.model.observes.at(-1)!.frameId,
    );
    frame?.close();
  });
  it("returns no picture before the first observation and authenticates the observation in effect", async () => {
    const fixture = setup();
    expect(await fixture.backdrop.frameAt(fixture.model, 99)).toBeNull();
    expect(fixture.requests).not.toHaveBeenCalled();
    const frame = await fixture.backdrop.frameAt(fixture.model, 125);
    expect(frame?.timestamp).toBe(125_000);
    const [url, init] = fixture.requests.mock.calls[0] ?? [];
    expect(url).toBe(
      `${fixture.source.origin}/api/sessions/${fixture.source.sessionId}/frames/${fixture.model.observes[0]?.frameId}`,
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(fixture.source.authorization);
    frame?.close();
    (await fixture.backdrop.frameAt(fixture.model, 150))?.close();
    expect(fixture.requests).toHaveBeenCalledTimes(1);
  });
  it("keeps six decoded images and closes evictions and shutdown images", async () => {
    const fixture = setup(BACKDROP_CACHE + 2);
    for (const observation of fixture.model.observes) {
      (await fixture.backdrop.frameAt(fixture.model, observation.t))?.close();
    }
    expect(fixture.images.filter((image) => image.close.mock.calls.length === 0)).toHaveLength(
      BACKDROP_CACHE,
    );
    fixture.backdrop.close();
    fixture.backdrop.close();
    expect(fixture.images.every((image) => image.close.mock.calls.length === 1)).toBe(true);
  });
  it("shares an in-flight observation and delivers only the latest requested time", async () => {
    const fixture = setup();
    const ready = Promise.withResolvers<void>();
    fixture.requests.mockImplementation(async () => {
      await ready.promise;
      return new Response("pixels");
    });
    const first = fixture.backdrop.frameAt(fixture.model, 110);
    const latest = fixture.backdrop.frameAt(fixture.model, 120);
    ready.resolve();
    expect(await first).toBeNull();
    const frame = await latest;
    expect(frame?.timestamp).toBe(120_000);
    frame?.close();
    expect(fixture.requests).toHaveBeenCalledTimes(1);
  });
  it("closes an image which finishes decoding after shutdown", async () => {
    const fixture = setup();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const close = vi.fn();
    fixture.decode.mockImplementation(async () => {
      entered.resolve();
      await resume.promise;
      return { close };
    });
    const pending = fixture.backdrop.frameAt(fixture.model, 110);
    await entered.promise;
    fixture.backdrop.close();
    resume.resolve();
    expect(await pending).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
