import { describe, expect, it } from "vitest";
import { type DecodeState, nextDecodeStep, sourceAt } from "./decode-policy.ts";

const state: DecodeState = {
  targetMs: 150,
  mode: "play",
  shownMs: 100,
  shownKeyMs: 0,
  targetKeyMs: 0,
  nextMs: 200,
};

describe("replay decode scheduling", () => {
  it("preview holds within the same GOP", () => {
    expect(nextDecodeStep({ ...state, mode: "preview" })).toBe("hold");
  });
  it("preview seeks the target key when the GOP changed or nothing is shown", () => {
    expect(nextDecodeStep({ ...state, mode: "preview", targetKeyMs: 150 })).toBe("seek-key");
    expect(nextDecodeStep({ ...state, mode: "preview", shownKeyMs: null })).toBe("seek-key");
  });
  it("exact holds the last frame at or before the target", () => {
    expect(nextDecodeStep({ ...state, mode: "exact" })).toBe("hold");
    expect(nextDecodeStep({ ...state, mode: "exact", nextMs: null })).toBe("hold");
  });
  it("exact advances a running iterator inside the same GOP", () => {
    expect(nextDecodeStep({ ...state, mode: "exact", targetMs: 200 })).toBe("advance");
  });
  it("exact seeks from the preceding key when the GOP changed", () => {
    expect(nextDecodeStep({ ...state, mode: "exact", targetKeyMs: 150 })).toBe("seek-exact");
  });
  it("exact seek backwards always re-seeks", () => {
    expect(nextDecodeStep({ ...state, mode: "exact", targetMs: 50 })).toBe("seek-exact");
  });
  it("play seeks when the iterator has ended or time moves backwards", () => {
    expect(nextDecodeStep({ ...state, nextMs: null })).toBe("seek-exact");
    expect(nextDecodeStep({ ...state, targetMs: 50 })).toBe("seek-exact");
  });
  it("play jumps to the key frame when more than 1.5 seconds behind", () => {
    expect(nextDecodeStep({ ...state, targetMs: 1701 })).toBe("seek-key");
    expect(nextDecodeStep({ ...state, targetMs: 1700 })).toBe("advance");
  });
  it("play advances when the next sample is due", () => {
    expect(nextDecodeStep({ ...state, targetMs: 200 })).toBe("advance");
  });
  it("play holds until the next sample is due", () => {
    expect(nextDecodeStep(state)).toBe("hold");
  });
});

describe("replay frame source", () => {
  const video = {
    hasVideo: true,
    firstMs: 100,
    lastMs: 5000,
    gaps: [
      { from: 1_000_000, to: 2_000_000, reason: "user-control" as const },
      { from: 3_000_000, to: 3_500_000, reason: "stream-lost" as const },
      { from: 5_000_000, to: null, reason: "disk-full" as const },
    ],
  };
  it("uses observations before video, holds during takeover, and falls back after disk exhaustion", () => {
    expect(sourceAt(99, video)).toBe("backdrop");
    expect(sourceAt(100, video)).toBe("video");
    expect(sourceAt(1000, video)).toBe("hold");
    expect(sourceAt(1999.999, video)).toBe("hold");
    expect(sourceAt(2000, video)).toBe("video");
    expect(sourceAt(3000, video)).toBe("backdrop");
    expect(sourceAt(3500, video)).toBe("video");
    expect(sourceAt(5001, video)).toBe("backdrop");
  });
  it("uses observations without a recording and holds the last completed frame after its end", () => {
    expect(sourceAt(1500, { ...video, hasVideo: false })).toBe("backdrop");
    expect(sourceAt(1500, { ...video, firstMs: null })).toBe("backdrop");
    expect(sourceAt(6000, { ...video, gaps: [] })).toBe("video");
  });
});
