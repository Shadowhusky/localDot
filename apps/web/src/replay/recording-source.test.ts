import { emptyManifest } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplaySource } from "../stage/worker-protocol.ts";
import { openRecording, recordingSnapshot, recordingUrl } from "./recording-source.ts";

const source: ReplaySource = {
  sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
  origin: "http://127.0.0.1:4750",
  authorization: "Bearer synthetic-replay-fixture",
  video: { upto: null },
  gaps: [],
};
afterEach(() => vi.restoreAllMocks());

describe("recording requests", () => {
  it("pins a live snapshot in the URL without putting credentials there", () => {
    expect(recordingUrl({ ...source, video: { upto: 3 } })).toBe(
      `${source.origin}/api/sessions/${source.sessionId}/recording/video.mp4?upto=3`,
    );
    expect(recordingUrl(source)).not.toContain("?");
    expect(recordingUrl(source)).not.toContain("synthetic");
    expect(() => recordingUrl({ ...source, video: { upto: -1 } })).toThrow(RangeError);
    expect(() => recordingUrl({ ...source, sessionId: "../private" })).toThrow(RangeError);
    expect(() => recordingUrl({ ...source, origin: "http://user:secret@127.0.0.1:4750" })).toThrow(
      RangeError,
    );
  });
  it("names the size a finished video was opened at, so a compacted one is not mixed in", () => {
    const url = new URL(recordingUrl({ ...source, video: { upto: null, bytes: 4096 } }));
    expect(url.searchParams.get("bytes")).toBe("4096");
    expect(url.searchParams.has("upto")).toBe(false);
    expect(() => recordingUrl({ ...source, video: { upto: null, bytes: 1.5 } })).toThrow(
      RangeError,
    );
    const info = { manifest: emptyManifest("complete"), upto: 3, servedBytes: 4096 };
    expect(recordingSnapshot({ ...info, live: false })).toEqual({ upto: null, bytes: 4096 });
    expect(recordingSnapshot({ ...info, live: true })).toEqual({ upto: 3 });
  });
  it("pins browser snapshots to the browser endpoint and rejects unknown screen names", () => {
    const url = new URL(recordingUrl({ ...source, screen: "browser", video: { upto: 7 } }));
    expect(url.searchParams.get("screen")).toBe("browser");
    expect(url.searchParams.get("upto")).toBe("7");
    expect(() => recordingUrl({ ...source, screen: "unknown" as "browser" })).toThrow();
  });
  it.each([401, 403, 404, 416])(
    "does not retry HTTP %i and keeps bearer auth in headers and allows same-origin relay cookies",
    async (status) => {
      const requests: { url: string; init?: RequestInit }[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response("private backend response", { status });
      });
      const input = openRecording(source);
      try {
        await expect(input.getPrimaryVideoTrack()).rejects.toThrow(
          `Recording request failed (${status}).`,
        );
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toBe(recordingUrl(source));
        const headers = new Headers(requests[0]?.init?.headers);
        expect(headers.get("authorization")).toBe(source.authorization);
        expect(requests[0]?.init?.redirect).toBe("error");
        expect(requests[0]?.init?.credentials).toBe("same-origin");
      } finally {
        input.dispose();
      }
    },
  );
});
