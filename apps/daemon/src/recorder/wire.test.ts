import { SYNTH_CODEC, synthFrame } from "@localdot/stage/testing";
import { describe, expect, it } from "vitest";
import { avcCodecString, isRandomAccess, nalTypes } from "./annexb.ts";
import { parseSelkiesMessage } from "./wire.ts";

const synth = { widthMbs: 4, heightMbs: 4, keyEvery: 12 };
function message(payload: Uint8Array, flags = 0x11): Uint8Array {
  const data = new Uint8Array(12 + payload.length);
  const v = new DataView(data.buffer);
  v.setUint8(0, 4);
  v.setUint8(1, flags);
  v.setUint16(2, 513);
  v.setUint16(6, 2560);
  v.setUint16(8, 1600);
  data.set(payload, 12);
  return data;
}
describe("Selkies wire and Annex B", () => {
  it("parses a key H.264 frame and its header", () => {
    const frame = synthFrame(synth, 0);
    const data = message(frame.data);
    const padded = new Uint8Array(data.length + 7);
    padded.set(data, 7);
    expect(parseSelkiesMessage(padded.subarray(7))).toEqual({
      kind: "video",
      key: true,
      codec: 1,
      frameId: 513,
      region: 0,
      width: 2560,
      height: 1600,
      data: frame.data,
    });
  });
  it("reads a delta frame, ignores other message types and empty video", () => {
    const delta = synthFrame(synth, 1).data;
    expect(parseSelkiesMessage(message(delta, 0x10))).toMatchObject({
      kind: "video",
      key: false,
      data: delta,
    });
    expect(parseSelkiesMessage(Uint8Array.of(3, 1))).toEqual({ kind: "ignored", type: 3 });
    expect(parseSelkiesMessage(message(new Uint8Array()))).toEqual({ kind: "ignored", type: 4 });
    expect(parseSelkiesMessage(new Uint8Array())).toEqual({ kind: "ignored", type: -1 });
  });
  it("finds parameter sets and the IDR, and the codec string", () => {
    const key = synthFrame(synth, 0).data;
    expect(nalTypes(key)).toEqual([7, 8, 5]);
    expect(isRandomAccess(key)).toBe(true);
    expect(isRandomAccess(synthFrame(synth, 1).data)).toBe(false);
    expect(isRandomAccess(Uint8Array.of(0, 0, 1, 0x65, 1))).toBe(false);
    expect(avcCodecString(key)).toBe(SYNTH_CODEC);
    expect(avcCodecString(Uint8Array.of(0, 0, 1, 0x67))).toBeNull();
    expect(
      nalTypes(Uint8Array.of(0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e, 0, 0, 1, 0x68, 0, 0, 1, 0x65)),
    ).toEqual([7, 8, 5]);
  });
});
