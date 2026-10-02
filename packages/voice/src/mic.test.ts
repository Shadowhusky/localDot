import { describe, expect, it, vi } from "vitest";
import { FRAME_SAMPLES, FrameBatcher, MIC_MESSAGES, micProblem, openMic } from "./mic.ts";

describe("micProblem", () => {
  it("names a refusal, a missing microphone and anything else", () => {
    expect(micProblem(new DOMException("denied", "NotAllowedError"))).toBe("denied");
    expect(micProblem(new DOMException("insecure", "SecurityError"))).toBe("denied");
    expect(micProblem(new DOMException("none", "NotFoundError"))).toBe("no_device");
    expect(micProblem(new DOMException("busy", "NotReadableError"))).toBe("unavailable");
    expect(micProblem("weird")).toBe("unavailable");
  });
});

describe("openMic", () => {
  it("explains how to allow the microphone when permission is denied", async () => {
    const mediaDevices = {
      getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
    };
    expect(await openMic(() => {}, { mediaDevices })).toEqual({
      ok: false,
      problem: "denied",
      message: MIC_MESSAGES.denied,
    });
    expect(MIC_MESSAGES.denied).toMatch(/site settings/);
    expect(MIC_MESSAGES.denied).toMatch(/Typing still works/);
  });

  it("asks for echo cancellation so her own voice does not count as the user's", async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("none", "NotFoundError")));
    expect(await openMic(() => {}, { mediaDevices: { getUserMedia } })).toMatchObject({
      problem: "no_device",
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  });

  it("reports a browser without microphone access as unavailable", async () => {
    expect(await openMic(() => {}, {})).toMatchObject({ ok: false, problem: "unavailable" });
  });
});

describe("FrameBatcher", () => {
  it("turns worklet blocks into 30 ms int16 frames", () => {
    const frames: Int16Array[] = [];
    const batcher = new FrameBatcher((pcm) => frames.push(pcm));
    for (let i = 0; i < 4; i++) batcher.push(new Float32Array(128).fill(0.5));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(FRAME_SAMPLES);
    expect(frames[0]?.[0]).toBe(16384);
  });
});
