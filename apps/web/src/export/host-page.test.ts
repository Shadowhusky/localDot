// @vitest-environment jsdom
import { type ExportPageMessage, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExportHandle, startExport } from "./exporter.ts";
import { base64, bindingSink, createExportHost } from "./host-page.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const sessionId = ulid();
const request = {
  sessionId,
  fromMs: 0,
  toMs: 2000,
  speed: 1,
  skipIdle: false,
  captions: true,
  overlays: true,
  size: { w: 1280, h: 800 },
  fps: 30,
  quality: "high",
  format: "mp4",
};
const info = {
  manifest: {
    v: 1,
    state: "complete",
    codec: "avc1.42c033",
    width: 2560,
    height: 1600,
    firstMicros: 0,
    lastMicros: 2_000_000,
    bytes: 100,
    fragments: 1,
    activity: [{ from: 0, to: 2_000_000 }],
    gaps: [],
    finalized: true,
  },
  live: false,
  upto: 1,
  servedBytes: 100,
};

describe("the export page's sink", () => {
  it("sends each chunk to the daemon and waits for it to be on disk", async () => {
    const sent: ExportPageMessage[] = [];
    const sink = bindingSink((message) => sent.push(message));
    let written = false;
    const writing = sink.write(4, new Uint8Array([1, 2, 3])).then(() => {
      written = true;
    });
    await Promise.resolve();
    expect(sent).toEqual([{ type: "chunk", seq: 0, position: 4, data: "AQID" }]);
    expect(written).toBe(false);
    sink.ack(0);
    await writing;
    expect(written).toBe(true);
    await expect(sink.write(0, new Uint8Array(4 * 1024 * 1024 + 1))).rejects.toThrow(RangeError);
  });

  it("encodes bytes the same with or without the browser's own base64", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("the export page", () => {
  function host() {
    const sent: ExportPageMessage[] = [];
    const runs: Parameters<typeof startExport>[0][] = [];
    let finish: (result: Awaited<ExportHandle["done"]>) => void = () => {};
    let progress: (value: { done: number; total: number }) => void = () => {};
    const cancel = vi.fn();
    const start = ((options: Parameters<typeof startExport>[0]) => {
      runs.push(options);
      return {
        done: new Promise((resolve) => {
          finish = resolve;
        }),
        cancel,
        onProgress(callback: (value: { done: number; total: number }) => void) {
          progress = callback;
        },
      } as unknown as ExportHandle;
    }) as typeof startExport;
    const page = createExportHost({
      send: (message) => sent.push(message),
      start,
      origin: "http://127.0.0.1:4750",
      check: async () => ({ maxPixels: { mp4: 1, webm: 0 }, decodes: true, graphics: "x" }),
    });
    return {
      page,
      sent,
      runs,
      cancel,
      finish: (result: Awaited<ExportHandle["done"]>) => finish(result),
      progress: (value: { done: number; total: number }) => progress(value),
    };
  }

  it("reads the recording with the daemon's token and makes the video with the same exporter", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push(
          `${url.pathname}${url.search} ${new Headers(init?.headers).get("authorization")}`,
        );
        if (url.pathname.endsWith("/recording")) return Response.json(info);
        return new Response("", { headers: { "content-type": "application/x-ndjson" } });
      }),
    );
    const { page, sent, runs, finish, progress } = host();
    page.run({ token: "a".repeat(43), screen: "desktop", request });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(requests).toEqual([
      `/api/sessions/${sessionId}/recording Bearer ${"a".repeat(43)}`,
      `/api/sessions/${sessionId}/events?fromSeq=0 Bearer ${"a".repeat(43)}`,
    ]);
    const run = runs[0];
    expect(run?.request).toEqual(request);
    expect(run?.source).toMatchObject({
      screen: "desktop",
      sessionId,
      origin: "http://127.0.0.1:4750",
      geometry: { w: 2560, h: 1600, scale: 1 },
      video: { upto: null },
    });
    progress({ done: 15, total: 60 });
    finish({ type: "done", frames: 60, bytes: 123, hashes: null });
    await vi.waitFor(() =>
      expect(sent).toEqual([
        { type: "progress", done: 15, total: 60 },
        { type: "done", frames: 60, bytes: 123 },
      ]),
    );
    page.run({ token: "a".repeat(43), screen: "desktop", request });
    expect(runs).toHaveLength(1);
  });

  it("refuses a spec it can't trust and reports the exporter's failure", async () => {
    const refused = host();
    refused.page.run({ token: "short", screen: "desktop", request });
    expect(refused.sent).toEqual([
      { type: "error", message: "The video couldn't be made. Try again." },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );
    const missing = host();
    missing.page.run({ token: "a".repeat(43), screen: "browser", request });
    await vi.waitFor(() =>
      expect(missing.sent).toEqual([
        { type: "error", message: "The video couldn't be made. Try again." },
      ]),
    );
  });
});
