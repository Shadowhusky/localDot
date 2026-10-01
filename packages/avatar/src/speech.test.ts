import { describe, expect, it } from "vitest";
import { MOUTH_STEP_MS, mouthAt, prepareTrack, type SpeechTrack, speechSpan } from "./speech.ts";

const track: SpeechTrack = prepareTrack({
  lang: "en",
  startsAt: 1000,
  visemes: [
    { t: 0, shape: "E" },
    { t: 120, shape: "O" },
    { t: 260, shape: "A" },
    { t: 500, shape: "rest" },
  ],
});

describe("mouthAt", () => {
  it("is at rest with no track and before the lead-in", () => {
    expect(mouthAt(null, 0)).toEqual({ shape: "rest", open: 0 });
    expect(mouthAt(track, 1000 - 151)).toEqual({ shape: "rest", open: 0 });
  });

  it("starts opening toward the first shape 150 ms early", () => {
    const m = mouthAt(track, 1000 - 50);
    expect(m.shape).toBe("E");
    expect(m.open).toBeGreaterThan(0);
    expect(m.open).toBeLessThan(0.3);
  });

  it("shows the viseme in effect, changing only on the 12 fps grid within one step", () => {
    const changes: { at: number; shape: string }[] = [];
    let previous = mouthAt(track, 1000).shape;
    for (let t = 1000; t <= 1600; t++) {
      const shape = mouthAt(track, t).shape;
      if (shape !== previous) changes.push({ at: t - 1000, shape });
      previous = shape;
    }
    expect(changes.map((c) => c.shape)).toEqual(["O", "A", "rest"]);
    const onsets = { O: 120, A: 260, rest: 500 } as const;
    for (const change of changes) {
      const onset = onsets[change.shape as keyof typeof onsets];
      expect(change.at).toBeGreaterThanOrEqual(onset);
      expect(change.at - onset).toBeLessThanOrEqual(MOUTH_STEP_MS + 1);
    }
  });

  it("scales openness by the audio envelope and survives a short envelope", () => {
    // 10 Hz envelope: index 3 covers 300–399 ms; index 4 (400 ms on) is past the end.
    const withEnvelope = prepareTrack({
      ...track,
      envelope: new Float32Array([1, 1, 1, 0.5]),
      envelopeRateHz: 10,
    });
    expect(mouthAt(withEnvelope, 1000 + 350)).toEqual({
      shape: "A",
      open: expect.closeTo(0.65, 12),
    });
    expect(mouthAt(withEnvelope, 1000 + 450)).toEqual({
      shape: "A",
      open: expect.closeTo(0.3, 12),
    });
  });

  it("closes the mouth if a track never ends with rest", () => {
    const open = prepareTrack({ lang: "zh", startsAt: 0, visemes: [{ t: 0, shape: "A" }] });
    expect(mouthAt(open, 200).shape).toBe("A");
    expect(mouthAt(open, 1000)).toEqual({ shape: "rest", open: 0 });
  });
});

describe("prepareTrack", () => {
  it("sorts visemes and drops non-finite times", () => {
    const t = prepareTrack({
      lang: "ja",
      startsAt: 0,
      visemes: [
        { t: 300, shape: "O" },
        { t: Number.NaN, shape: "A" },
        { t: 100, shape: "I" },
      ],
    });
    expect(t.visemes.map((v) => v.t)).toEqual([100, 300]);
  });

  it("leaves an empty track or one with an invalid start silent", () => {
    expect(mouthAt(prepareTrack({ lang: "en", startsAt: 0, visemes: [] }), 50)).toEqual({
      shape: "rest",
      open: 0,
    });
    const badStart = prepareTrack({
      lang: "en",
      startsAt: Number.NaN,
      visemes: [{ t: 0, shape: "A" }],
    });
    expect(mouthAt(badStart, 50)).toEqual({ shape: "rest", open: 0 });
  });
});

describe("speechSpan", () => {
  it("runs from the mouth's lead-in to the last syllable", () => {
    expect(speechSpan(track)).toEqual({ from: 850, to: 1500 });
  });

  it("allows the closing tail when a track never comes to rest", () => {
    const open = prepareTrack({ lang: "en", startsAt: 0, visemes: [{ t: 0, shape: "A" }] });
    expect(speechSpan(open)).toEqual({ from: -150, to: 400 });
  });

  it("has no span without a track or a start", () => {
    expect(speechSpan(null)).toBeNull();
    expect(speechSpan({ ...track, startsAt: Number.NaN })).toBeNull();
    expect(speechSpan({ ...track, visemes: [] })).toBeNull();
  });
});
