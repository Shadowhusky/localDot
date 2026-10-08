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

// Safari has no MediaStreamTrackProcessor; frames come from the client's <video> instead.
function stubCallbackVideo(trackId = "t9") {
  vi.stubGlobal("OffscreenCanvas", class {});
  const made: { close: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal(
    "VideoFrame",
    class {
      readonly close = vi.fn();
      constructor(readonly source: unknown) {
        made.push(this);
      }
    },
  );
  let pending: ((now: number, meta: unknown) => void) | undefined;
  const cancelled: number[] = [];
  let next = 0;
  const video = {
    srcObject: { getVideoTracks: () => [{ id: trackId }] },
    readyState: 0,
    requestVideoFrameCallback: (cb: (now: number, meta: unknown) => void) => {
      pending = cb;
      return ++next;
    },
    cancelVideoFrameCallback: (id: number) => cancelled.push(id),
  };
  const fire = () => {
    const cb = pending;
    pending = undefined;
    cb?.(0, {});
  };
  return { video, made, fire, cancelled, armed: () => pending !== undefined };
}

describe("frame source without MediaStreamTrackProcessor", () => {
  it("is supported where a <video> reports its frames", () => {
    const { video } = stubCallbackVideo();
    vi.stubGlobal("HTMLVideoElement", { prototype: { requestVideoFrameCallback: () => 0 } });
    expect(frameTapSupport()).toEqual({ ok: true });
    expect(tapVideoTrack(video)?.trackId).toBe("t9");
  });

  it("explains itself when neither path exists", () => {
    stubCallbackVideo();
    vi.stubGlobal("HTMLVideoElement", { prototype: {} });
    const support = frameTapSupport();
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toMatch(/Safari|Chrome/);
  });

  it("delivers each frame the video presents, one by one", () => {
    const { video, made, fire } = stubCallbackVideo();
    const source = tapVideoTrack(video);
    if (!source?.frames) throw new Error("no frames");
    expect(source.readable).toBeUndefined();
    const got: unknown[] = [];
    source.frames((frame) => got.push(frame));
    fire();
    fire();
    expect(got).toEqual([made[0], made[1]]);
    source.stop();
  });

  it("stops asking for frames on stop", () => {
    const { video, made, fire, cancelled, armed } = stubCallbackVideo();
    const source = tapVideoTrack(video);
    if (!source?.frames) throw new Error("no frames");
    source.frames(() => {});
    expect(armed()).toBe(true);
    source.stop();
    expect(cancelled).toHaveLength(1);
    fire();
    expect(made).toHaveLength(0);
  });
});
