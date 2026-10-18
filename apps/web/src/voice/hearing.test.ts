// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { type HearingEvents, speechFailure, startHearing } from "./hearing.ts";
import type { SpeechRecognitionLike, SpeechResultLike } from "./support.ts";

const mic = vi.hoisted(() => ({
  refuse: undefined as Error | undefined,
  closed: 0,
  audio: new Float32Array(16_000),
}));
vi.mock("./capture.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./capture.ts")>()),
  openCapture: async () => {
    if (mic.refuse) throw mic.refuse;
    return {
      level: () => 0.3,
      audio: async () => mic.audio,
      close: () => {
        mic.closed += 1;
      },
    };
  },
}));

let made: FakeRecognition[];
class FakeRecognition implements SpeechRecognitionLike {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  processLocally?: boolean;
  onstart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onspeechend: (() => void) | null = null;
  onresult: ((event: { results: ArrayLike<SpeechResultLike> }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  stopped = 0;
  aborted = 0;
  constructor() {
    made.push(this);
  }
  start() {}
  stop() {
    this.stopped += 1;
  }
  abort() {
    this.aborted += 1;
  }
  say(...words: string[]) {
    this.onresult?.({
      results: words.map((transcript) => ({ isFinal: false, 0: { transcript } })),
    });
  }
}

const events = (): HearingEvents & { words: string[]; failures: string[]; ends: number } => {
  const seen = { words: [] as string[], failures: [] as string[], ends: 0 };
  return Object.assign(seen, {
    partial: (text: string) => seen.words.push(text),
    failed: (failure: string) => seen.failures.push(failure),
    ended: () => {
      seen.ends += 1;
    },
  });
};
const api = (fetchImpl: typeof fetch = async () => new Response("{}")) =>
  createApi("fixture", { origin: "http://127.0.0.1:4790", fetchImpl });

beforeEach(() => {
  made = [];
  mic.refuse = undefined;
  mic.closed = 0;
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
});
afterEach(() => {
  for (const recognition of made) recognition.onend?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("hearing in the browser", () => {
  it("listens on this device only for the device route, and hands over what it heard", async () => {
    const seen = events();
    const opening = startHearing({ kind: "device" }, { api: api(), language: "ja-JP" }, seen);
    await vi.waitFor(() => expect(made).toHaveLength(1));
    const recognition = made[0] as FakeRecognition;
    expect(recognition).toMatchObject({
      lang: "ja-JP",
      continuous: true,
      interimResults: true,
      processLocally: true,
    });
    recognition.onstart?.();
    const hearing = await opening;
    recognition.say("明日", "の天気");
    expect(seen.words).toEqual(["明日の天気"]);
    const words = hearing.finish();
    expect(recognition.stopped).toBe(1);
    recognition.onend?.();
    await expect(words).resolves.toBe("明日の天気");
    expect(mic.closed).toBe(0);
  });

  it("goes online only for the online route", async () => {
    const opening = startHearing({ kind: "online" }, { api: api(), language: "en-US" }, events());
    await vi.waitFor(() => expect(made).toHaveLength(1));
    expect(made[0]?.processLocally).toBeUndefined();
    made[0]?.onstart?.();
    await opening;
  });

  it("refuses to start when the engine says no", async () => {
    const opening = startHearing({ kind: "device" }, { api: api(), language: "en-US" }, events());
    await vi.waitFor(() => expect(made).toHaveLength(1));
    made[0]?.onerror?.({ error: "language-not-supported" });
    await expect(opening).rejects.toMatchObject({ failure: "unavailable" });
    expect(made[0]?.aborted).toBe(1);
    expect(mic.closed).toBe(0);
  });

  it("reports a failure or an end the engine reached by itself", async () => {
    const seen = events();
    const opening = startHearing({ kind: "device" }, { api: api(), language: "en-US" }, seen);
    await vi.waitFor(() => expect(made).toHaveLength(1));
    made[0]?.onstart?.();
    await opening;
    made[0]?.onerror?.({ error: "no-speech" });
    made[0]?.onerror?.({ error: "aborted" });
    made[0]?.onend?.();
    expect(seen.failures).toEqual(["no-speech"]);
    expect(seen.ends).toBe(0);
    expect(made[0]?.aborted).toBe(1);
  });

  it("maps the engine's errors", () => {
    expect(speechFailure("not-allowed")).toBe("denied");
    expect(speechFailure("audio-capture")).toBe("no-mic");
    expect(speechFailure("network")).toBe("network");
    expect(speechFailure("aborted")).toBeNull();
    expect(speechFailure("bad-grammar")).toBe("failed");
  });
});

describe("hearing on the computer", () => {
  it("sends the recording as WAV with the language and returns the words", async () => {
    const sent: { url: string; type: string | null; bytes: number; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({
        url: String(url),
        type: headers.get("content-type"),
        bytes: (init?.body as Uint8Array | undefined)?.length ?? 0,
        auth: headers.get("authorization"),
      });
      return new Response(JSON.stringify({ text: "hello dot" }));
    }) as typeof fetch;
    const hearing = await startHearing(
      { kind: "mac" },
      { api: api(fetchImpl), language: "zh-TW" },
      events(),
    );
    await expect(hearing.finish()).resolves.toBe("hello dot");
    expect(sent).toEqual([
      {
        url: "http://127.0.0.1:4790/api/voice/transcribe?lang=zh",
        type: "audio/wav",
        bytes: 44 + 32_000,
        auth: "Bearer fixture",
      },
    ]);
  });

  it("hears nothing in a recording too short to hold words, and says why the computer refused", async () => {
    mic.audio = new Float32Array(100);
    const quiet = await startHearing({ kind: "mac" }, { api: api(), language: "en-US" }, events());
    await expect(quiet.finish()).resolves.toBe("");
    mic.audio = new Float32Array(16_000);
    const busy = await startHearing(
      { kind: "mac" },
      { api: api(async () => new Response("busy", { status: 409 })), language: "en-US" },
      events(),
    );
    await expect(busy.finish()).rejects.toMatchObject({ failure: "busy" });
  });
});

it("starts recognition synchronously in the user gesture without opening a second microphone", async () => {
  mic.refuse = new Error("A second microphone must not be opened");
  const opening = startHearing({ kind: "online" }, { api: api(), language: "en-US" }, events());
  expect(made).toHaveLength(1);
  made[0]?.onstart?.();
  const hearing = await opening;
  hearing.abort();
  expect(made[0]?.aborted).toBe(1);
  expect(mic.closed).toBe(0);
});
it("settles if recognition closes before it starts", async () => {
  const opening = startHearing({ kind: "online" }, { api: api(), language: "en-US" }, events());
  made[0]?.onend?.();
  await expect(opening).rejects.toMatchObject({ failure: "no-speech" });
});

it("animates detected speech and result activity, then settles during silence and after abort", async () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const opening = startHearing({ kind: "online" }, { api: api(), language: "en-US" }, events());
    const recognition = made[0];
    if (!recognition) throw new Error("Expected a speech session");
    recognition.onstart?.();
    const hearing = await opening;
    expect(hearing.level()).toBe(0);
    recognition.onspeechstart?.();
    const first = hearing.level();
    now = 180;
    expect(hearing.level()).toBeGreaterThan(0.3);
    expect(hearing.level()).not.toBe(first);
    recognition.onspeechend?.();
    expect(hearing.level()).toBe(0);
    recognition.say("still speaking");
    expect(hearing.level()).toBeGreaterThan(0.3);
    now += 1400;
    expect(hearing.level()).toBe(0);
    recognition.onspeechstart?.();
    hearing.abort();
    expect(hearing.level()).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

describe("successive speech sessions", () => {
  it("releases every finished recognizer before the next recording and ignores old callbacks", async () => {
    for (const phrase of ["first message", "second message", "third message"]) {
      const seen = events();
      const opening = startHearing({ kind: "online" }, { api: api(), language: "en-US" }, seen);
      const recognition = made.at(-1);
      if (!recognition) throw new Error("Expected a speech session");
      recognition.onstart?.();
      const hearing = await opening;
      recognition.say(phrase);
      const staleResult = recognition.onresult;
      const final = hearing.finish();
      expect(hearing.finish()).toBe(final);
      recognition.onend?.();
      await expect(final).resolves.toBe(phrase);
      expect(recognition.aborted).toBe(1);
      expect(recognition.onresult).toBeNull();
      expect(recognition.onend).toBeNull();
      staleResult?.({ results: [{ isFinal: true, 0: { transcript: "late words" } }] });
      expect(seen.words).toEqual([phrase]);
      expect(hearing.level()).toBe(0);
    }
  });

  it("cancels during startup immediately so a fresh recording can acquire the microphone", async () => {
    const signal = new AbortController();
    const first = startHearing(
      { kind: "online" },
      { api: api(), language: "en-US", signal: signal.signal },
      events(),
    );
    const abandoned = made[0];
    if (!abandoned) throw new Error("Expected a speech session");
    const lateStart = abandoned.onstart;
    const rejected = expect(first).rejects.toMatchObject({ failure: "failed" });
    signal.abort();
    await rejected;
    expect(abandoned.aborted).toBe(1);
    expect(abandoned.onstart).toBeNull();
    lateStart?.();
    const seen = events();
    const next = startHearing({ kind: "online" }, { api: api(), language: "en-US" }, seen);
    made[1]?.onstart?.();
    const hearing = await next;
    made[1]?.say("fresh words");
    expect(seen.words).toEqual(["fresh words"]);
    hearing.abort();
  });

  it("releases a service that never sends its final end event", async () => {
    vi.useFakeTimers();
    const seen = events();
    const opening = startHearing({ kind: "online" }, { api: api(), language: "en-US" }, seen);
    made[0]?.onstart?.();
    const hearing = await opening;
    made[0]?.say("keep these words");
    const words = hearing.finish();
    await vi.advanceTimersByTimeAsync(4000);
    await expect(words).resolves.toBe("keep these words");
    expect(made[0]?.aborted).toBe(1);
    expect(made[0]?.onend).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(made).toHaveLength(1);
    expect(seen.failures).toEqual([]);
  });

  it("recovers one silently stalled microphone with a fresh recognizer", async () => {
    vi.useFakeTimers();
    const seen = events();
    const opening = startHearing({ kind: "online" }, { api: api(), language: "en-US" }, seen);
    made[0]?.onstart?.();
    const hearing = await opening;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(made).toHaveLength(2);
    expect(made[0]?.aborted).toBe(1);
    made[1]?.onstart?.();
    made[1]?.say("I can be heard again");
    expect(seen.words).toEqual(["I can be heard again"]);
    const words = hearing.finish();
    made[1]?.onend?.();
    await expect(words).resolves.toBe("I can be heard again");
    expect(seen.failures).toEqual([]);
  });

  it("bounds silent retries and releases the microphone after failure", async () => {
    vi.useFakeTimers();
    const seen = events();
    const opening = startHearing({ kind: "online" }, { api: api(), language: "en-US" }, seen);
    made[0]?.onstart?.();
    await opening;
    await vi.advanceTimersByTimeAsync(12_000);
    made[1]?.onstart?.();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(seen.failures).toEqual(["no-speech"]);
    expect(made[1]?.aborted).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(made).toHaveLength(2);
  });

  it("cancels a pending final result without retaining a finish timer", async () => {
    vi.useFakeTimers();
    const opening = startHearing({ kind: "online" }, { api: api(), language: "en-US" }, events());
    made[0]?.onstart?.();
    const hearing = await opening;
    const words = hearing.finish();
    hearing.abort();
    await expect(words).resolves.toBe("");
    expect(vi.getTimerCount()).toBe(0);
    expect(made[0]?.aborted).toBe(1);
  });
});

it("cancels an in-flight computer transcription and releases its capture", async () => {
  let request: AbortSignal | undefined;
  const hearing = await startHearing(
    { kind: "mac" },
    {
      api: api((async (_url, init) => {
        request = init?.signal as AbortSignal;
        return new Promise((_resolve, reject) =>
          request?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
        );
      }) as typeof fetch),
      language: "en-US",
    },
    events(),
  );
  const words = hearing.finish();
  expect(hearing.finish()).toBe(words);
  await vi.waitFor(() => expect(request).toBeDefined());
  hearing.abort();
  await expect(words).rejects.toMatchObject({ failure: "failed" });
  expect(request?.aborted).toBe(true);
  expect(mic.closed).toBeGreaterThan(0);
});
