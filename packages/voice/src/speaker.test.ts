import { describe, expect, it } from "vitest";
import { VoicePlayer } from "./player.ts";
import { Speaker } from "./speaker.ts";
import { FakeAudioContext, RecordingSink, tone } from "./testing.ts";
import type { TtsClientMessage } from "./wire.ts";

const setup = (online = true) => {
  const ctx = new FakeAudioContext();
  const sink = new RecordingSink();
  const player = new VoicePlayer(ctx.asPlayback(), sink, () => 0);
  const sent: TtsClientMessage[] = [];
  const errors: [number | null, string][] = [];
  const speaker = new Speaker(
    player,
    (m) => {
      sent.push(m);
      return online;
    },
    { error: (id, code) => errors.push([id, code]) },
  );
  return { ctx, sink, player, sent, errors, speaker };
};

describe("Speaker", () => {
  it("sends each sentence as soon as it completes, with its own language", () => {
    const { sent, speaker } = setup();
    const reply = speaker.reply();
    reply.push("你终于回来了。I sorted");
    expect(sent).toEqual([{ type: "say", id: 1, text: "你终于回来了。", lang: "zh" }]);
    reply.push(" your \t  folder. やっとね");
    reply.end();
    expect(sent.slice(1)).toEqual([
      { type: "say", id: 2, text: "I sorted your folder.", lang: "en" },
      { type: "say", id: 3, text: "やっとね", lang: "ja" },
    ]);
  });

  it("plays what comes back and lets the aligned track take over the mouth", () => {
    const { ctx, sink, speaker } = setup();
    speaker.say("Hello there.");
    speaker.audio({ id: 1, seq: 0, pcm: tone(0.2, 0.15) });
    speaker.message({ type: "end", id: 1, samples: 4800 });
    speaker.message({
      type: "track",
      id: 1,
      lang: "en",
      visemes: [
        { t: 0, shape: "E" },
        { t: 150, shape: "rest" },
      ],
    });
    expect(ctx.sources).toHaveLength(1);
    expect(sink.last?.visemes.map((v) => v.shape)).toEqual(["E", "rest"]);
  });

  it("stops the voice and cancels the queue on barge-in", () => {
    const { ctx, sink, sent, speaker } = setup();
    speaker.say("One. Two. Three.");
    speaker.audio({ id: 1, seq: 0, pcm: tone(0.3, 0.15) });
    speaker.stop();
    expect(sent.at(-1)).toEqual({ type: "cancel" });
    expect(ctx.sources[0]?.stopped).toBe(true);
    expect(sink.last).toBeNull();
    speaker.audio({ id: 2, seq: 0, pcm: tone(0.3, 0.15) });
    expect(ctx.sources).toHaveLength(1);
  });

  it("lets nothing more of a reply through once she is interrupted", () => {
    const { ctx, sink, sent, speaker } = setup();
    const reply = speaker.reply();
    reply.push("First sentence here. Second");
    speaker.audio({ id: 1, seq: 0, pcm: tone(0.3, 0.15) });
    speaker.stop();
    reply.push(" sentence keeps streaming. Third.");
    reply.end();
    expect(sent.at(-1)).toEqual({ type: "cancel" });
    expect(ctx.sources).toHaveLength(1);
    expect(sink.last).toBeNull();
    speaker.say("A new reply.");
    expect(sent.at(-1)).toMatchObject({ type: "say", text: "A new reply." });
  });

  it("closes a sentence that fails after its audio starts, so the track moves on", () => {
    const { ctx, sink, speaker } = setup();
    speaker.say(Array.from({ length: 41 }, (_, i) => `Line ${i + 1}.`).join(" "));
    speaker.audio({ id: 1, seq: 0, pcm: tone(0.3, 0.15) });
    speaker.message({ type: "error", id: 1, code: "synthesis_failed", message: "" });
    expect(sink.last?.visemes.map((v) => [Math.round(v.t), v.shape])).toEqual([
      [0, "A"],
      [300, "rest"],
    ]);
    for (let id = 2; id <= 41; id++) {
      speaker.audio({ id, seq: 0, pcm: tone(0.5, 0.15) });
      speaker.message({ type: "end", id, samples: 12_000 });
      ctx.currentTime += 0.5;
    }
    // Only the last few sentences are still within a second of playing.
    expect(sink.last?.startsAt).toBeGreaterThan(5000 + 25_000);
    expect(sink.last?.envelope?.length).toBeLessThanOrEqual(250);
  });

  it("reports each sentence as unavailable while the voice route is down", () => {
    const { errors, speaker } = setup(false);
    speaker.say("Still here. Just quiet.");
    expect(errors).toEqual([
      [1, "unavailable"],
      [2, "unavailable"],
    ]);
  });
});
