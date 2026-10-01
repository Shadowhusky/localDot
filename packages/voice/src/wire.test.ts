import { describe, expect, it } from "vitest";
import { downsample, float32ToInt16, int16ToFloat32 } from "./pcm.ts";
import {
  decodeAudioFrame,
  encodeAudioFrame,
  parseSttServerMessage,
  parseTtsServerMessage,
} from "./wire.ts";

// The same bytes voiced's encode_audio_frame(7, 2, [0, 1, -1, 32767, -32768]) produces.
const FRAME_HEX = "070000000200000000000100ffffff7f0080";
const hex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

describe("audio frames", () => {
  it("decodes voiced's frames byte for byte, from any offset in a buffer", () => {
    expect(decodeAudioFrame(hex(FRAME_HEX))).toEqual({
      id: 7,
      seq: 2,
      pcm: new Int16Array([0, 1, -1, 32767, -32768]),
    });
    const padded = new Uint8Array(19);
    padded.set(hex(FRAME_HEX), 1);
    expect(decodeAudioFrame(padded.subarray(1))?.seq).toBe(2);
  });

  it("encodes what it decodes and refuses a torn frame", () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
    expect(Buffer.from(encodeAudioFrame(7, 2, pcm)).toString("hex")).toBe(FRAME_HEX);
    expect(decodeAudioFrame(new Uint8Array(7))).toBeNull();
    expect(decodeAudioFrame(new Uint8Array(9))).toBeNull();
  });
});

describe("PCM", () => {
  it("converts between int16 and float without leaving [-1, 1]", () => {
    expect([...int16ToFloat32(new Int16Array([16384, -32768]))]).toEqual([0.5, -1]);
    expect([...float32ToInt16(new Float32Array([0.5, -0.5, 1.5, -1.5]))]).toEqual([
      16384, -16384, 32767, -32768,
    ]);
  });

  it("averages down to 16 kHz", () => {
    const out = downsample(new Float32Array([0, 0.3, 0.6, 0.9, 0.6, 0.3]), 48_000, 16_000);
    expect([...out].map((v) => Math.round(v * 10) / 10)).toEqual([0.3, 0.6]);
  });
});

describe("server messages", () => {
  it("accepts well-formed TTS messages and drops anything else", () => {
    expect(parseTtsServerMessage('{"type":"ready","voice":"pack"}')).toEqual({
      type: "ready",
      voice: "pack",
    });
    expect(
      parseTtsServerMessage('{"type":"track","id":1,"lang":"ja","visemes":[{"t":0,"shape":"A"}]}'),
    ).toEqual({ type: "track", id: 1, lang: "ja", visemes: [{ t: 0, shape: "A" }] });
    expect(parseTtsServerMessage('{"type":"error","id":null,"code":"bad_request"}')).toEqual({
      type: "error",
      id: null,
      code: "bad_request",
      message: "",
    });
    for (const bad of [
      "nope",
      "[]",
      '{"type":"track","id":1,"lang":"fr","visemes":[]}',
      '{"type":"track","id":1,"lang":"en","visemes":[{"t":0,"shape":"X"}]}',
      '{"type":"end","id":-1,"samples":3}',
      '{"type":"mystery"}',
    ]) {
      expect(parseTtsServerMessage(bad)).toBeNull();
    }
  });

  it("reads STT messages, with an unknown language as null", () => {
    expect(parseSttServerMessage('{"type":"final","utterance":2,"text":"hi","lang":"en"}')).toEqual(
      { type: "final", utterance: 2, text: "hi", lang: "en" },
    );
    expect(
      parseSttServerMessage('{"type":"end","utterance":2,"text":"salut","lang":null}'),
    ).toEqual({ type: "end", utterance: 2, text: "salut", lang: null });
    expect(parseSttServerMessage('{"type":"partial","utterance":"x"}')).toBeNull();
  });
});
