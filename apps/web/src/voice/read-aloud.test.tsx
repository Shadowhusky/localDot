// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../agent/model.ts";
import { setListening } from "./listening.ts";
import {
  type ReadAloudInput,
  readable,
  replyLanguage,
  systemVoice,
  useReadAloud,
} from "./read-aloud.ts";

const voice = (lang: string, localService = true, isDefault = false) =>
  ({ lang, localService, default: isDefault, name: lang }) as SpeechSynthesisVoice;

class Utterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = "";
  constructor(readonly text: string) {}
}

let spoken: Utterance[];
let cancels: number;
beforeEach(() => {
  spoken = [];
  cancels = 0;
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => [voice("en-US"), voice("zh-CN"), voice("en-GB", false)],
    speak: (utterance: Utterance) => spoken.push(utterance),
    cancel: () => {
      cancels += 1;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setListening(false);
});

const reply = (id: string, text: string, final = true): [string, AgentMessage] => [
  id,
  { id, role: "assistant", text, final },
];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reading replies aloud", () => {
  it("picks a voice of this device, never one that sends the text away", () => {
    const voices = [voice("en-US", false), voice("en_GB"), voice("ja-JP", true, true)];
    expect(systemVoice(voices, "en-US")?.lang).toBe("en_GB");
    expect(systemVoice(voices, "ja-JP")?.lang).toBe("ja-JP");
    expect(systemVoice([voice("fr-FR", false)], "fr-FR")).toBeUndefined();
  });

  it("hears the language a reply is written in", () => {
    expect(replyLanguage("明日は晴れです", "en-US")).toBe("ja-JP");
    expect(replyLanguage("好的，我来订", "zh-TW")).toBe("zh-TW");
    expect(replyLanguage("好的", "en-US")).toBe("zh-CN");
    expect(replyLanguage("Done", "zh-CN")).toBe("en-US");
    expect(replyLanguage("Hecho", "es-ES")).toBe("es-ES");
  });

  it("reads sentences, not code, and stops long replies at a sentence", () => {
    expect(readable("## Booked\n\n- Table for **two**\n\n```sh\nrm -rf /\n```")).toBe(
      "Booked. Table for two.",
    );
    const long = readable(`${"This is a sentence. ".repeat(100)}`);
    expect(long.length).toBeLessThanOrEqual(1200);
    expect(long.endsWith(".")).toBe(true);
  });

  it("reads only replies that finish from now on, and only when on", async () => {
    const input: ReadAloudInput = {
      on: true,
      sessionId: "s1",
      history: true,
      messages: new Map([reply("a", "Earlier reply")]),
      language: "en-US",
    };
    const { rerender } = renderHook((props: ReadAloudInput) => useReadAloud(props), {
      initialProps: input,
    });
    rerender({
      ...input,
      messages: new Map([reply("a", "Earlier reply"), reply("b", "Stre", false)]),
    });
    rerender({
      ...input,
      messages: new Map([reply("a", "Earlier reply"), reply("b", "Streamed")]),
    });
    await flush();
    expect(spoken.map((utterance) => utterance.text)).toEqual(["Streamed."]);
    expect(spoken[0]?.voice?.lang).toBe("en-US");
    rerender({
      ...input,
      on: false,
      messages: new Map([reply("a", "x"), reply("b", "x"), reply("c", "Quiet")]),
    });
    await flush();
    expect(spoken).toHaveLength(1);
    expect(cancels).toBeGreaterThan(0);
  });

  it("waits for the history before counting what is new", async () => {
    const input: ReadAloudInput = {
      on: true,
      sessionId: "s2",
      history: false,
      messages: new Map(),
      language: "en-US",
    };
    const { rerender } = renderHook((props: ReadAloudInput) => useReadAloud(props), {
      initialProps: input,
    });
    rerender({ ...input, history: true, messages: new Map([reply("old", "From before")]) });
    await flush();
    expect(spoken).toEqual([]);
  });

  it("stops talking when the user talks", () => {
    renderHook(() =>
      useReadAloud({
        on: true,
        sessionId: null,
        history: false,
        messages: new Map(),
        language: "en-US",
      }),
    );
    const before = cancels;
    setListening(true);
    expect(cancels).toBeGreaterThan(before);
  });
});
