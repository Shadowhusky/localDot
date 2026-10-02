import { describe, expect, it } from "vitest";
import { Listener } from "./listener.ts";
import { socketFactory } from "./testing.ts";

const setup = (gate?: () => boolean) => {
  const { sockets, create } = socketFactory();
  const heard: string[] = [];
  const listener = new Listener(
    "ws://127.0.0.1:4753/voice/stt",
    {
      ready: () => heard.push("ready"),
      speechStarted: () => heard.push("speech"),
      partial: (t) => heard.push(`partial:${t}`),
      final: (t, lang) => heard.push(`final:${t}:${lang}`),
      utterance: (t, lang) => heard.push(`utterance:${t}:${lang}`),
      error: (code) => heard.push(`error:${code}`),
    },
    { create, ...(gate ? { gate } : {}) },
  );
  listener.open();
  sockets[0]?.open();
  return { socket: sockets[0], heard, listener };
};

describe("Listener", () => {
  it("asks to listen, streams frames as bytes and releases", () => {
    const { socket, listener } = setup();
    listener.listen("ptt");
    listener.frame(new Int16Array([1, -1]));
    listener.release();
    const [listen, audio, release] = socket?.sent ?? [];
    expect(listen).toBe('{"type":"listen","mode":"ptt"}');
    expect(Array.from(audio as Uint8Array)).toEqual([1, 0, 255, 255]);
    expect(release).toBe('{"type":"release"}');
  });

  it("reports speech, partial and final text, and sends a finished utterance on", () => {
    const { socket, heard } = setup();
    for (const message of [
      { type: "ready" },
      { type: "speech_started", utterance: 1 },
      { type: "partial", utterance: 1, text: "我在" },
      { type: "final", utterance: 1, text: "我在。", lang: "zh" },
      { type: "end", utterance: 1, text: "我在。", lang: "zh" },
      { type: "end", utterance: 2, text: "  ", lang: null },
      { type: "error", code: "unavailable", message: "refused" },
    ]) {
      socket?.receive(JSON.stringify(message));
    }
    expect(heard).toEqual([
      "ready",
      "speech",
      "partial:我在",
      "final:我在。:zh",
      "utterance:我在。:zh",
      "error:unavailable",
    ]);
  });

  it("holds frames back while its gate is shut", () => {
    let open = false;
    const { socket, listener } = setup(() => open);
    listener.frame(new Int16Array([1]));
    open = true;
    listener.frame(new Int16Array([2]));
    expect(socket?.sent.map((m) => [...(m as Uint8Array)])).toEqual([[2, 0]]);
  });
});
