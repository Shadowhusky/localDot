import type { Viseme } from "@localdot/avatar";
import { describe, expect, it, vi } from "vitest";
import type { TtsServerMessage } from "../wire.ts";
import { decodeAudioFrame } from "../wire.ts";
import {
  AlignmentCollector,
  ELEVENLABS_MODEL,
  ElevenLabsTts,
  type TimedUnit,
  voicedVisemes,
} from "./elevenlabs.ts";
import type { VoicedEndpoint } from "./local.ts";
import type { TtsOutput } from "./router.ts";

const CREDENTIALS = { key: "test-key", voiceId: "voice/1", model: ELEVENLABS_MODEL };
const pcmBase64 = (samples: number[]) =>
  Buffer.from(new Int16Array(samples).buffer).toString("base64");

function streamOf(text: string, cuts: number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const pieces = [0, ...cuts, bytes.length]
    .slice(1)
    .map((end, i, all) => bytes.slice(i === 0 ? 0 : (all[i - 1] as number), end));
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
  });
}

const collect = () => {
  const frames: number[][] = [];
  const messages: TtsServerMessage[] = [];
  const out: TtsOutput = {
    frame: (bytes) => frames.push([...(decodeAudioFrame(bytes)?.pcm ?? [])]),
    message: (m) => messages.push(m),
  };
  return { frames, messages, out };
};

describe("AlignmentCollector", () => {
  it("makes words of Latin runs and units of single Chinese or Japanese characters", () => {
    const collector = new AlignmentCollector();
    collector.push(
      {
        characters: ["我", "用", " ", "R", "e", "a", "c", "t", "。"],
        character_start_times_seconds: [0, 0.2, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7],
        character_end_times_seconds: [0.2, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8],
      },
      0,
    );
    expect(collector.units()).toEqual<TimedUnit[]>([
      { text: "我", start: 0, end: 0.2 },
      { text: "用", start: 0.2, end: 0.4 },
      { text: "React", start: 0.45, end: 0.7 },
    ]);
  });

  it("shifts a chunk whose times restart by the audio sent before it", () => {
    const collector = new AlignmentCollector();
    const chunk = (ch: string) => ({
      characters: [ch],
      character_start_times_seconds: [0],
      character_end_times_seconds: [0.3],
    });
    collector.push(chunk("你"), 0);
    collector.push(chunk("好"), 0.32);
    expect(collector.units().map((u) => [u.text, u.start])).toEqual([
      ["你", 0],
      ["好", 0.32],
    ]);
  });
});

describe("ElevenLabsTts", () => {
  it("posts the sentence, streams the PCM it returns and asks voiced for mouth shapes", async () => {
    const lines = [
      JSON.stringify({
        audio_base64: pcmBase64([1, 2]),
        alignment: {
          characters: ["H", "i"],
          character_start_times_seconds: [0, 0.1],
          character_end_times_seconds: [0.1, 0.2],
        },
      }),
      JSON.stringify({ audio_base64: pcmBase64([3]), alignment: null }),
      "",
    ].join("\n");
    const fetchImpl = vi.fn(async () => new Response(streamOf(lines, [7, 40, 41])));
    const visemesFor = vi.fn(async () => [
      { t: 0, shape: "I" as const },
      { t: 200, shape: "rest" as const },
    ]);
    const { frames, messages, out } = collect();
    const voice = new ElevenLabsTts(
      () => CREDENTIALS,
      out,
      visemesFor,
      fetchImpl as unknown as typeof fetch,
    );
    await voice.speak({ id: 9, text: "Hi", lang: "en" }, new AbortController().signal);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2F1/stream/with-timestamps?output_format=pcm_24000",
      expect.objectContaining({
        method: "POST",
        headers: { "xi-api-key": "test-key", "content-type": "application/json" },
        body: JSON.stringify({ text: "Hi", model_id: "eleven_v4_turbo", language_code: "en" }),
      }),
    );
    expect(frames).toEqual([[1, 2], [3]]);
    expect(visemesFor).toHaveBeenCalledWith("en", [{ text: "Hi", start: 0, end: 0.2 }]);
    expect(messages).toEqual([
      { type: "end", id: 9, samples: 3 },
      {
        type: "track",
        id: 9,
        lang: "en",
        visemes: [
          { t: 0, shape: "I" },
          { t: 200, shape: "rest" },
        ],
      },
    ]);
  });

  it("fails before any audio on a refused request, so the local voice can take over", async () => {
    const { out } = collect();
    const voice = new ElevenLabsTts(
      () => CREDENTIALS,
      out,
      async () => null,
      (async () => new Response("quota", { status: 429 })) as unknown as typeof fetch,
    );
    await expect(
      voice.speak({ id: 1, text: "Hi", lang: "en" }, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "synthesis_failed",
      audioSent: false,
    });
  });

  it("keeps the envelope when voiced cannot shape the mouth", async () => {
    const line = `${JSON.stringify({ audio_base64: pcmBase64([5]) })}\n`;
    const { messages, out } = collect();
    const voice = new ElevenLabsTts(
      () => CREDENTIALS,
      out,
      async () => {
        throw new Error("down");
      },
      (async () => new Response(streamOf(line, []))) as unknown as typeof fetch,
    );
    await voice.speak({ id: 2, text: "Hi", lang: "en" }, new AbortController().signal);
    expect(messages.at(-1)).toMatchObject({ type: "error", id: 2, code: "align_failed" });
  });

  it("lets go at once of a sentence cancelled while voiced shapes its mouth", async () => {
    const line = `${JSON.stringify({ audio_base64: pcmBase64([5]) })}\n`;
    const cancel = new AbortController();
    let answer: (visemes: Viseme[]) => void = () => {};
    const { messages, out } = collect();
    const voice = new ElevenLabsTts(
      () => CREDENTIALS,
      out,
      () => {
        cancel.abort();
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
      (async () => new Response(streamOf(line, []))) as unknown as typeof fetch,
    );
    const spoken = voice.speak({ id: 3, text: "Hi", lang: "en" }, cancel.signal);
    const settled = await Promise.race([
      spoken.then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ]);
    answer([{ t: 0, shape: "A" }]);
    await spoken;
    expect(settled).toBe("done");
    expect(messages).toEqual([{ type: "end", id: 3, samples: 1 }]);
  });
});

describe("voicedVisemes", () => {
  const units: TimedUnit[] = [{ text: "Hi", start: 0, end: 0.2 }];
  const VOICED: VoicedEndpoint = { host: "127.0.0.1:4752", token: "voiced-token" };

  it("asks voiced's /visemes for the mouth shapes of the timed units", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ visemes: [{ t: 0, shape: "I" }] }));
    const visemesFor = voicedVisemes(async () => VOICED, fetchImpl as unknown as typeof fetch);
    expect(await visemesFor("en", units)).toEqual([{ t: 0, shape: "I" }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4752/visemes",
      expect.objectContaining({
        method: "POST",
        headers: { authorization: "Bearer voiced-token", "content-type": "application/json" },
        body: JSON.stringify({ lang: "en", units }),
      }),
    );
  });

  it("stops waiting for a voiced that is still starting, so the next sentence is not held", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ visemes: [] }));
    const starting = () =>
      new Promise<VoicedEndpoint>((resolve) => setTimeout(() => resolve(VOICED), 200));
    const visemesFor = voicedVisemes(starting, fetchImpl as unknown as typeof fetch, 20);
    expect(await visemesFor("en", units)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
