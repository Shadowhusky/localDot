// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { frameTapSupport, tapVideoTrack } from "./frame-source.ts";

afterEach(() => vi.unstubAllGlobals());

// A track from the client's realm, and the processor and VideoFrame constructors of this one.
function stubTap(calls: string[] = []) {
  const stopped: string[] = [];
  const track = {
    id: "t1",
    clone: () => {
      calls.push("clone");
      return { id: "t1-clone", stop: () => stopped.push("clone") };
    },
  };
  const readable = new ReadableStream<VideoFrame>();
  vi.stubGlobal(
    "MediaStreamTrackProcessor",
    class {
      readonly readable = readable;
      constructor(readonly init: { track: unknown }) {}
    },
  );
  const frames: { source: unknown; close: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal(
    "VideoFrame",
    class {
      readonly close = vi.fn();
      constructor(readonly source: unknown) {
        calls.push("frame");
        frames.push(this);
      }
    },
  );
  return { track, readable, stopped, frames };
}

describe("frame source", () => {
  it("names the missing API in a browser without MediaStreamTrackProcessor", () => {
    const support = frameTapSupport();
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toContain("Chromium");
  });

  it("returns no source for a video without a stream", () => {
    const video = document.createElement("video");
    expect(tapVideoTrack(video)).toBeUndefined();
    expect(tapVideoTrack({ srcObject: {} })).toBeUndefined();
  });

  it("taps a track from another realm by shape, never by instanceof", () => {
    const { track, readable, stopped } = stubTap();
    const video = { srcObject: { getVideoTracks: () => [track] } };
    const source = tapVideoTrack(video);
    expect(source?.trackId).toBe("t1");
    expect(source?.readable).toBe(readable);
    expect(source?.first).toBeUndefined();
    source?.stop();
    expect(stopped).toEqual(["clone"]);
  });

  it("seeds the source with the video's current frame, taken after the clone, once it has one", () => {
    const calls: string[] = [];
    const { track, frames } = stubTap(calls);
    const loading = { srcObject: { getVideoTracks: () => [track] }, readyState: 1 };
    expect(tapVideoTrack(loading)?.first).toBeUndefined();
    calls.length = 0;
    const playing = { srcObject: { getVideoTracks: () => [track] }, readyState: 2 };
    const source = tapVideoTrack(playing);
    expect(source?.first).toBe(frames[0]);
    expect(frames[0]?.source).toBe(playing);
    expect(calls).toEqual(["clone", "frame"]);
    // A source nobody attached still holds its seed: stopping it releases both.
    source?.stop();
    expect(frames[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("taps without a seed when the video's frame cannot be read", () => {
    const { track } = stubTap();
    vi.stubGlobal(
      "VideoFrame",
      class {
        constructor() {
          throw new DOMException("no frame", "InvalidStateError");
        }
      },
    );
    const source = tapVideoTrack({ srcObject: { getVideoTracks: () => [track] }, readyState: 4 });
    expect(source?.trackId).toBe("t1");
    expect(source?.first).toBeUndefined();
  });
});
