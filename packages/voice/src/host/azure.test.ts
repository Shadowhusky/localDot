import { describe, expect, it } from "vitest";
import type { TtsServerMessage } from "../wire.ts";
import { decodeAudioFrame } from "../wire.ts";
import { type AzureSynth, AzureTts, azureVisemes, ssmlFor } from "./azure.ts";
import { ProviderError, type TtsOutput } from "./router.ts";

const CREDENTIALS = {
  key: "test-key",
  region: "eastus",
  voice: "zh-CN-XiaoxiaoMultilingualNeural",
};

const collect = () => {
  const frames: number[][] = [];
  const messages: TtsServerMessage[] = [];
  const out: TtsOutput = {
    frame: (bytes) => frames.push([...(decodeAudioFrame(bytes)?.pcm ?? [])]),
    message: (m) => messages.push(m),
  };
  return { frames, messages, out };
};

const fakeSynth = (behaviour: "speak" | "fail"): AzureSynth => ({
  speak: async (_ssml, onAudio, onViseme) => {
    if (behaviour === "fail") throw new Error("401 Unauthorized");
    onAudio(new Uint8Array([1, 0, 2]));
    onAudio(new Uint8Array([0, 3, 0]));
    for (const [ms, id] of [
      [0, 0],
      [50, 1],
      [100, 12],
      [150, 6],
      [200, 21],
      [250, 0],
    ] as const) {
      onViseme({ offsetTicks: ms * 10_000, id });
    }
  },
  close: () => {},
});

describe("azureVisemes", () => {
  it("maps Azure's viseme IDs to mouth shapes, holding the vowel through consonants", () => {
    const events = [
      { offsetTicks: 0, id: 0 },
      { offsetTicks: 500_000, id: 1 },
      { offsetTicks: 1_000_000, id: 12 },
      { offsetTicks: 1_500_000, id: 6 },
      { offsetTicks: 2_000_000, id: 21 },
      { offsetTicks: 2_500_000, id: 0 },
    ];
    expect(azureVisemes(events)).toEqual([
      { t: 50, shape: "A" },
      { t: 150, shape: "I" },
      { t: 200, shape: "N" },
      { t: 250, shape: "rest" },
    ]);
  });
});

describe("ssmlFor", () => {
  it("speaks escaped text in the sentence's language", () => {
    expect(ssmlFor('Tom & "Jerry" <3', "en")).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="zh-CN-XiaoxiaoMultilingualNeural"><lang xml:lang="en-US">Tom &amp; &quot;Jerry&quot; &lt;3</lang></voice></speak>',
    );
    expect(ssmlFor("やっと", "ja")).toContain('<lang xml:lang="ja-JP">やっと</lang>');
  });
});

describe("AzureTts", () => {
  it("streams Azure's audio as frames, then the end and a track from its visemes", async () => {
    const { frames, messages, out } = collect();
    const azure = new AzureTts(
      () => CREDENTIALS,
      out,
      async () => fakeSynth("speak"),
    );
    await azure.speak({ id: 4, text: "Hi.", lang: "en" }, new AbortController().signal);
    expect(frames).toEqual([[1], [2, 3]]);
    expect(messages).toEqual([
      { type: "end", id: 4, samples: 3 },
      {
        type: "track",
        id: 4,
        lang: "en",
        visemes: expect.arrayContaining([{ t: 50, shape: "A" }]),
      },
    ]);
  });

  it("fails cleanly so the router can fall back, when unconfigured or refused", async () => {
    const { out } = collect();
    const unconfigured = new AzureTts(
      () => null,
      out,
      async () => fakeSynth("speak"),
    );
    await expect(
      unconfigured.speak({ id: 1, text: "Hi.", lang: "en" }, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "unavailable",
      audioSent: false,
    });
    const refused = new AzureTts(
      () => CREDENTIALS,
      out,
      async () => fakeSynth("fail"),
    );
    const failure = await refused
      .speak({ id: 1, text: "Hi.", lang: "en" }, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({
      code: "synthesis_failed",
      message: "401 Unauthorized",
      audioSent: false,
    });
  });
});
