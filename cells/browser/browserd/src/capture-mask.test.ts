import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { BrowserCapture } from "./capture.ts";
import { captureMaskPacket } from "./capture-mask.ts";

const mask = {
  width: 1280,
  height: 800,
  content: [20, 100, 1000, 600],
  redactions: [[25, 120, 100, 30]],
};

function encodedFrame(id: number) {
  const frame = Buffer.alloc(38);
  frame.writeUInt32BE(id, 0);
  frame.writeUInt32BE(30, 4);
  frame.write("RIFF", 8);
  frame.writeUInt32LE(22, 12);
  frame.write("WEBPVP8 ", 16);
  frame.writeUInt32LE(10, 24);
  frame.set([0x9d, 0x01, 0x2a], 31);
  frame.writeUInt16LE(1280, 34);
  frame.writeUInt16LE(800, 36);
  return frame;
}

async function peer() {
  const input = new PassThrough();
  const output = new PassThrough();
  const packets: Buffer[] = [];
  input.on("data", (data) => packets.push(Buffer.from(data)));
  const onFatal = vi.fn();
  const capture = new BrowserCapture({ input, output, onFatal });
  output.write(Buffer.from("LDCP"));
  await capture.ready;
  return { capture, packets, output, onFatal };
}

describe("private masked browser capture", () => {
  it.each([1, 2])("encodes bounded physical rectangles at scale %i", (scale) => {
    const packet = captureMaskPacket({
      width: 1280 * scale,
      height: 800 * scale,
      content: [0, 80 * scale, 1280 * scale, 720 * scale],
      redactions: [[0, 80 * scale, 16 * scale, 20 * scale]],
    });
    expect(
      Array.from({ length: 13 }, (_unused, position) => packet.readUInt32BE(position * 4)),
    ).toEqual([
      0,
      0,
      1280 * scale,
      800 * scale,
      0,
      80 * scale,
      1280 * scale,
      720 * scale,
      1,
      0,
      80 * scale,
      16 * scale,
      20 * scale,
    ]);
  });

  it.each([
    undefined,
    null,
    [],
    { ...mask, width: 2560 },
    { ...mask, height: 1600 },
    { ...mask, raw: true },
    { ...mask, content: [0, 0, 0, 800] },
    { ...mask, content: [0.1, 0, 1280, 800] },
    { ...mask, content: [-1, 0, 1280, 800] },
    { ...mask, content: [0, 0, 1281, 800] },
    { ...mask, content: [0, 0, 1280, 801] },
    { ...mask, redactions: [[0, 0, Infinity, 1]] },
    { ...mask, redactions: [[0, 0, 1, -1]] },
    { ...mask, redactions: Array.from({ length: 257 }, () => [0, 0, 1, 1]) },
    { ...mask, redactions: new Array(2) },
  ])("refuses invalid requests without allocating a nonce %#", async (invalid) => {
    const fixture = await peer();
    await expect(fixture.capture.masked(invalid)).rejects.toThrow("mask");
    expect(fixture.packets).toEqual([]);
    const pending = fixture.capture.masked(mask);
    expect(fixture.packets[0]?.readUInt32BE(4)).toBe(1);
    fixture.output.write(encodedFrame(1));
    await expect(pending).resolves.toEqual(encodedFrame(1).subarray(8));
    expect(fixture.onFatal).not.toHaveBeenCalled();
    fixture.capture.close();
  });

  it("captures inert masks without invoking getters, proxies or inherited data", () => {
    const trap = vi.fn(() => {
      throw new Error("private canary");
    });
    const accessor = Object.defineProperty({ ...mask }, "content", { get: trap, enumerable: true });
    const nested = [0, 0, 10, 10];
    Object.defineProperty(nested, "0", { get: trap, enumerable: true });
    for (const invalid of [
      accessor,
      new Proxy(mask, { get: trap, ownKeys: trap }),
      { ...mask, content: nested },
      Object.create(mask),
      { ...mask, [Symbol("secret")]: 1 },
    ])
      expect(() => captureMaskPacket(invalid)).toThrow("capture mask");
    expect(trap).not.toHaveBeenCalled();
  });

  it("copies requests and shares sequence and single-flight ownership with raw capture", async () => {
    const fixture = await peer();
    const value = structuredClone(mask);
    const pending = fixture.capture.masked(value);
    value.redactions[0] = [0, 0, 1280, 800];
    expect(fixture.packets[0]?.readUInt32BE(36)).toBe(25);
    await expect(fixture.capture.capture()).rejects.toThrow("busy");
    fixture.output.write(encodedFrame(1));
    await pending;
    const raw = fixture.capture.capture();
    expect(fixture.packets[1]).toEqual(Buffer.from([0, 0, 0, 2]));
    fixture.output.write(encodedFrame(2));
    await raw;
    fixture.capture.close();
  });

  it("fences masked capture cancellation and never publishes late pixels", async () => {
    const fixture = await peer();
    const abort = new AbortController();
    const pending = expect(fixture.capture.masked(mask, abort.signal)).rejects.toThrow("aborted");
    abort.abort();
    fixture.output.emit("data", encodedFrame(1));
    await pending;
    expect(fixture.onFatal).toHaveBeenCalledTimes(1);
    expect(fixture.capture.alive).toBe(false);
  });
});
