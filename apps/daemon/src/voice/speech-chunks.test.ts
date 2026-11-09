import { describe, expect, it } from "vitest";
import { speechChunks } from "./speech-chunks.ts";

const RATE = 16_000;

// Speech as a loud tone, with the given quiet gaps. Seconds of each in turn: loud, quiet, loud...
function recording(...parts: number[]): Uint8Array {
  const samples = Math.round(parts.reduce((a, b) => a + b, 0) * RATE);
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  let at = 0;
  parts.forEach((seconds, index) => {
    const count = Math.round(seconds * RATE);
    for (let i = 0; i < count; i++) {
      view.setInt16(44 + at * 2, index % 2 === 0 ? Math.round(Math.sin(i / 3) * 12_000) : 0, true);
      at += 1;
    }
  });
  return out;
}

const seconds = (wav: Uint8Array) => (wav.length - 44) / 2 / RATE;
const dataLength = (wav: Uint8Array) =>
  new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(40, true);

describe("splitting a long recording", () => {
  it("leaves a short recording whole", () => {
    const wav = recording(5);
    expect(speechChunks(wav)).toEqual([wav]);
  });

  it("splits at a pause, not through a word", () => {
    const chunks = speechChunks(recording(12, 1, 12), 15);
    expect(chunks).toHaveLength(2);
    expect(seconds(chunks[0] ?? new Uint8Array())).toBeGreaterThan(12);
    expect(seconds(chunks[0] ?? new Uint8Array())).toBeLessThan(13);
  });

  it("never loses a sample, and every piece is a playable WAV", () => {
    const wav = recording(10, 0.5, 20, 0.5, 30, 0.5, 40);
    const chunks = speechChunks(wav, 15);
    expect(chunks.reduce((total, chunk) => total + chunk.length - 44, 0)).toBe(wav.length - 44);
    for (const chunk of chunks) {
      expect(String.fromCharCode(...chunk.subarray(0, 4))).toBe("RIFF");
      expect(dataLength(chunk)).toBe(chunk.length - 44);
    }
  });

  it("keeps every piece within the limit, even with no pause at all", () => {
    const chunks = speechChunks(recording(120), 15);
    expect(chunks.length).toBeGreaterThanOrEqual(8);
    for (const chunk of chunks) expect(seconds(chunk)).toBeLessThanOrEqual(15.01);
  });
});
