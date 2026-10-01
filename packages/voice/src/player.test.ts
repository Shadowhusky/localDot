import { MOUTH_LEAD_MS } from "@localdot/avatar";
import { describe, expect, it } from "vitest";
import { START_LEAD_S, VoicePlayer } from "./player.ts";
import { FakeAudioContext, RecordingSink, tone } from "./testing.ts";

const setup = () => {
  const ctx = new FakeAudioContext();
  const sink = new RecordingSink();
  const player = new VoicePlayer(ctx.asPlayback(), sink, () => 5000 + ctx.currentTime * 1000);
  return { ctx, sink, player };
};
const shapes = (track: { visemes: { t: number; shape: string }[] } | null | undefined) =>
  (track?.visemes ?? []).map((v) => [Math.round(v.t), v.shape]);

describe("VoicePlayer", () => {
  it("schedules a reply's first chunk just ahead and the rest back to back", () => {
    const { ctx, player } = setup();
    player.begin(1, "en");
    player.audio(1, tone(0.1, 0.15));
    player.audio(1, tone(0.1, 0.15));
    expect(ctx.sources.map((s) => s.startedAt)).toEqual([
      10 + START_LEAD_S,
      10 + START_LEAD_S + 0.1,
    ]);
  });

  it("moves the mouth from the audio envelope before the alignment arrives, on the output clock", () => {
    const { sink, player } = setup();
    player.begin(1, "en");
    player.audio(1, tone(0.1, 0.15));
    player.audio(1, tone(0.1, 0));
    expect(sink.last?.startsAt).toBeCloseTo(5000 + 10_160 + 50, 6);
    expect(shapes(sink.last)).toEqual([
      [0, "A"],
      [100, "rest"],
    ]);
    expect(player.firstAudioAt(1)).toBeCloseTo(15_210, 6);
  });

  it("hands the mouth its first track in time for the whole pre-open", () => {
    const { ctx, sink, player } = setup();
    player.begin(1, "en");
    player.audio(1, tone(0.1, 0.15));
    expect(sink.tracks).toHaveLength(1);
    // The track arrives as the chunk is scheduled; output latency only adds to the lead.
    const leadMs = ((ctx.sources[0]?.startedAt ?? 0) - ctx.currentTime) * 1000;
    expect(leadMs).toBeGreaterThanOrEqual(MOUTH_LEAD_MS);
  });

  it("swaps in a sentence's aligned visemes, offset by the sentences before it", () => {
    const { sink, player } = setup();
    player.begin(1, "en");
    player.begin(2, "en");
    player.audio(1, tone(0.2, 0.15));
    player.end(1);
    player.audio(2, tone(0.2, 0.15));
    player.track(2, [
      { t: 0, shape: "O" },
      { t: 100, shape: "rest" },
    ]);
    expect(shapes(sink.last)).toEqual([
      [0, "A"],
      [200, "O"],
      [300, "rest"],
    ]);
    // Exact, not 199.999…: an onset on a 12 fps frame boundary must not slip a frame late.
    expect(sink.last?.visemes.map((v) => v.t)).toEqual([0, 200, 300]);
  });

  it("keeps later visemes in sync when a chunk arrives late", () => {
    const { ctx, sink, player } = setup();
    player.begin(1, "ja");
    player.audio(1, tone(0.1, 0.15));
    ctx.currentTime = 10.3;
    player.audio(1, tone(0.1, 0.15));
    expect(ctx.sources[1]?.startedAt).toBeCloseTo(10.32, 9);
    player.track(1, [
      { t: 0, shape: "A" },
      { t: 150, shape: "I" },
    ]);
    expect(shapes(sink.last)).toEqual([
      [0, "A"],
      [210, "I"],
    ]);
  });

  it("keeps the envelope whole across back-to-back sentences", () => {
    const { sink, player } = setup();
    [0.205, 0.2, 0.2].forEach((seconds, i) => {
      player.begin(i + 1, "en");
      player.audio(i + 1, tone(seconds, 0.15));
      player.end(i + 1);
    });
    const envelope = [...(sink.last?.envelope ?? [])];
    expect(envelope).toHaveLength(60);
    expect(envelope.every((level) => level > 0.5)).toBe(true);
  });

  it("stops every sound and closes the mouth on barge-in, then ignores the old sentences", () => {
    const { ctx, sink, player } = setup();
    player.begin(1, "en");
    player.begin(2, "en");
    player.audio(1, tone(0.5, 0.15));
    player.audio(2, tone(0.5, 0.15));
    player.stop();
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    expect(sink.last).toBeNull();
    expect(player.speaking).toBe(false);
    player.audio(2, tone(0.1, 0.15));
    expect(ctx.sources).toHaveLength(2);
    player.begin(3, "en");
    player.audio(3, tone(0.1, 0.15));
    expect(ctx.sources[2]?.startedAt).toBeCloseTo(10 + START_LEAD_S, 9);
  });

  it("fades out over 15 ms on barge-in instead of cutting the waveform", () => {
    const { ctx, player } = setup();
    player.begin(1, "en");
    player.audio(1, tone(0.5, 0.15));
    player.audio(1, tone(0.5, 0.15));
    ctx.currentTime = 10.4;
    player.stop();
    const end = 10.4 + 0.015;
    expect(ctx.gains.map((g) => g.automation)).toEqual([
      [
        ["set", 1, 10.4],
        ["ramp", 0, end],
      ],
      [
        ["set", 1, 10.4],
        ["ramp", 0, end],
      ],
    ]);
    expect(ctx.sources.map((s) => s.stoppedAt)).toEqual([end, end]);
    for (const source of ctx.sources) source.onended?.();
    expect([...ctx.sources, ...ctx.gains].every((node) => !node.connected)).toBe(true);
  });

  it("keeps the mouth still while the browser holds audio back, then moves with the sound", async () => {
    const { ctx, sink, player } = setup();
    ctx.state = "suspended";
    player.begin(1, "en");
    player.audio(1, tone(0.2, 0.15));
    expect(player.blocked).toBe(true);
    expect(sink.tracks).toEqual([]);
    await player.unlock();
    expect(player.blocked).toBe(false);
    expect(sink.last?.visemes.map((v) => v.shape)).toEqual(["A"]);
  });

  it("drops sentences that finished playing, so a long reply's track stays small", () => {
    const { ctx, sink, player } = setup();
    for (let id = 1; id <= 40; id++) {
      player.begin(id, "en");
      player.audio(id, tone(0.5, 0.15));
      player.end(id);
      ctx.currentTime += 0.5;
    }
    // Sentences 37 to 40 are still within a second of playing; the track starts at sentence 37.
    const track = sink.last;
    expect(track?.visemes.length).toBeLessThanOrEqual(8);
    expect(track?.startsAt).toBeCloseTo(5000 + (10 + START_LEAD_S + 36 * 0.5) * 1000 + 50, 6);
  });

  it("ends an envelope-only sentence at rest", () => {
    const { sink, player } = setup();
    player.begin(1, "zh");
    player.audio(1, tone(0.2, 0.15));
    player.end(1);
    expect(shapes(sink.last)).toEqual([
      [0, "A"],
      [200, "rest"],
    ]);
  });
});
