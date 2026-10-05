import { emptyManifest, RecordingManifest } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
  frameOfLuma,
  keyLevel,
  SYNTH_CODEC,
  SYNTH_WHITE,
  synthFrame,
  synthStream,
} from "./h264-synth.ts";

const o = { widthMbs: 8, heightMbs: 8, keyEvery: 20 };
const nalTypes = (au: Uint8Array) => {
  const t: number[] = [];
  for (let i = 0; i + 3 < au.length; i++)
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) t.push((au[i + 3] ?? 0) & 0x1f);
  return t;
};
// What a decoder must show for frame i: the GOP's level, with the first p macroblocks white.
const expectedLuma = (i: number) => {
  const p = i % o.keyEvery;
  return Array.from({ length: 64 }, (_, mb) =>
    mb < p ? SYNTH_WHITE : keyLevel(Math.floor(i / o.keyEvery)),
  );
};

describe("synthetic H.264", () => {
  it("starts each GOP with SPS, PPS and an IDR, and codes other frames as one P slice", () => {
    expect(nalTypes(synthFrame(o, 0).data)).toEqual([7, 8, 5]);
    expect(nalTypes(synthFrame(o, 20).data)).toEqual([7, 8, 5]);
    expect(nalTypes(synthFrame(o, 7).data)).toEqual([1]);
    expect(
      synthStream(o, 41)
        .filter((f) => f.key)
        .map((f) => f.index),
    ).toEqual([0, 20, 40]);
  });

  it("never leaves a start-code prefix inside a NAL payload", () => {
    for (const f of synthStream(o, 40)) {
      const payloads = Buffer.from(f.data).toString("hex").split("00000001").slice(1);
      expect(payloads).toHaveLength(nalTypes(f.data).length);
      // 00 00 0x (x ≤ 3) at a byte boundary inside a payload would read as a start code.
      for (const hex of payloads) expect(/^(?:..)*?00000[0-3]/.test(hex)).toBe(false);
    }
  });

  it("reads the frame index back from the decoded picture", () => {
    for (const i of [0, 1, 19, 20, 21, 39, 59]) expect(frameOfLuma(o, expectedLuma(i))).toBe(i);
  });

  it("identifies every GOP level before its documented 190-GOP repeat", () => {
    for (let gop = 0; gop < 190; gop++) {
      for (const p of [0, 1, 19]) {
        const index = gop * o.keyEvery + p;
        expect(frameOfLuma(o, expectedLuma(index))).toBe(index);
      }
    }
  });

  it("rejects a painted block out of order even when the white count matches a frame", () => {
    const small = { widthMbs: 2, heightMbs: 2, keyEvery: 4 };
    expect(() => frameOfLuma(small, [16, SYNTH_WHITE, 16, 16])).toThrow();
  });

  it("rejects mixed backgrounds from different GOPs", () => {
    const small = { widthMbs: 2, heightMbs: 2, keyEvery: 4 };
    expect(() =>
      frameOfLuma(small, [keyLevel(1), keyLevel(0), keyLevel(0), keyLevel(0)]),
    ).toThrow();
  });

  it("uses the canonical codec accepted by recording manifests", () => {
    expect(
      RecordingManifest.parse({ ...emptyManifest("recording"), codec: SYNTH_CODEC }).codec,
    ).toBe("avc1.42c01e");
  });

  it("rejects invalid dimensions, frame indices, counts and incomplete decoded pictures", () => {
    expect(() => synthFrame({ ...o, widthMbs: 0 }, 0)).toThrow(RangeError);
    expect(() => synthFrame({ ...o, heightMbs: 1.5 }, 0)).toThrow(RangeError);
    expect(() => synthFrame(o, -1)).toThrow(RangeError);
    expect(() => synthStream(o, -1)).toThrow(RangeError);
    expect(() => synthStream(o, 1.5)).toThrow(RangeError);
    expect(() => frameOfLuma(o, [16])).toThrow(RangeError);
    expect(synthStream(o, 0)).toEqual([]);
  });

  it("refuses a GOP longer than the picture has macroblocks", () => {
    const small = { widthMbs: 2, heightMbs: 2, keyEvery: 4 };
    expect(() => synthFrame({ ...small, keyEvery: 5 }, 0)).toThrow(RangeError);
    expect(() => synthFrame({ ...small, keyEvery: 6 }, 0)).toThrow(RangeError);
    expect(frameOfLuma(small, [SYNTH_WHITE, SYNTH_WHITE, SYNTH_WHITE, keyLevel(0)])).toBe(3);
  });
});
