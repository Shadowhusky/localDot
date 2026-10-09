// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { VoiceError } from "./capture.ts";
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
afterEach(() => vi.unstubAllGlobals());

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
    expect(mic.closed).toBe(1);
  });

  it("goes online only for the online route", async () => {
    const opening = startHearing({ kind: "online" }, { api: api(), language: "en-US" }, events());
    await vi.waitFor(() => expect(made).toHaveLength(1));
    expect(made[0]?.processLocally).toBeUndefined();
    made[0]?.onstart?.();
    await opening;
  });

  it("refuses to start when the mic or the engine says no", async () => {
    mic.refuse = new VoiceError("denied");
    await expect(
      startHearing({ kind: "device" }, { api: api(), language: "en-US" }, events()),
    ).rejects.toMatchObject({ failure: "denied" });
    mic.refuse = undefined;
    const opening = startHearing({ kind: "device" }, { api: api(), language: "en-US" }, events());
    await vi.waitFor(() => expect(made).toHaveLength(1));
    made[0]?.onerror?.({ error: "language-not-supported" });
    await expect(opening).rejects.toMatchObject({ failure: "unavailable" });
    expect(made[0]?.aborted).toBe(1);
    expect(mic.closed).toBe(1);
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
    expect(seen.ends).toBe(1);
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
