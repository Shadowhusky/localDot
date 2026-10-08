import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_CAPTURE_TIMEOUT_MS,
  BrowserCapture,
  MAX_BROWSER_CAPTURE_BYTES,
  MAX_BROWSER_CAPTURE_CHUNK,
} from "./capture.ts";

function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: Buffer[] = [];
  input.on("data", (chunk) => written.push(Buffer.from(chunk)));
  const fatal = vi.fn();
  const capture = new BrowserCapture({ input, output, onFatal: fatal });
  return { input, output, written, fatal, capture };
}

function image() {
  const encoded = Buffer.alloc(30);
  encoded.write("RIFF", 0, "ascii");
  encoded.writeUInt32LE(22, 4);
  encoded.write("WEBPVP8 ", 8, "ascii");
  encoded.writeUInt32LE(10, 16);
  encoded.set([0x9d, 0x01, 0x2a], 23);
  encoded.writeUInt16LE(1280, 26);
  encoded.writeUInt16LE(800, 28);
  return encoded;
}

function reply(id: number, encoded = image()) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(id);
  header.writeUInt32BE(encoded.length, 4);
  return Buffer.concat([header, encoded]);
}

async function started() {
  const peer = fixture();
  peer.output.write(Buffer.from("LDCP"));
  await peer.capture.ready;
  return peer;
}

afterEach(() => vi.useRealTimers());

describe("bounded private browser capture", () => {
  it.each(["frame", "retirement"] as const)(
    "settles and fences despite abort listener cleanup throwing during %s",
    async (phase) => {
      const peer = await started();
      const abort = new AbortController();
      const pending = expect(peer.capture.capture(abort.signal)).rejects.toThrow("closed");
      const remove = vi.spyOn(abort.signal, "removeEventListener").mockImplementation(() => {
        throw new Error("private-abort-cleanup-canary");
      });
      try {
        expect(() => {
          if (phase === "frame") peer.output.write(reply(1));
          else peer.capture.close();
        }).not.toThrow();
        await pending;
        expect(peer.fatal).toHaveBeenCalledTimes(1);
        expect(peer.capture.alive).toBe(false);
        expect(peer.input.destroyed && peer.output.destroyed).toBe(true);
        await expect(peer.capture.capture()).rejects.toThrow("closed");
      } finally {
        remove.mockRestore();
        peer.capture.close();
      }
    },
  );

  it("fences before invoking stream cleanup observers", async () => {
    const peer = await started();
    const observed: number[] = [];
    peer.output.on("removeListener", (event) => {
      if (event === "data") observed.push(peer.fatal.mock.calls.length);
    });
    const pending = expect(peer.capture.capture()).rejects.toThrow("closed");
    peer.capture.close();
    await pending;
    expect(observed).toEqual([1]);
    expect(peer.input.destroyed && peer.output.destroyed).toBe(true);
  });

  it("requires the exact ready handshake before accepting one request", async () => {
    const peer = fixture();
    await expect(peer.capture.capture()).rejects.toThrow("unready");
    expect(peer.written).toEqual([]);
    peer.output.write(Buffer.from("LD"));
    expect(peer.capture.alive).toBe(false);
    peer.output.write(Buffer.from("CP"));
    await peer.capture.ready;
    const result = peer.capture.capture();
    await expect(peer.capture.capture()).rejects.toThrow("busy");
    expect(peer.written).toHaveLength(1);
    expect(peer.written[0]?.readUInt32BE()).toBe(1);
    peer.output.write(reply(1));
    await expect(result).resolves.toEqual(image());
    expect(peer.capture.alive).toBe(true);
    peer.capture.close();
  });

  it("assembles arbitrary header and image fragments without exposing an incomplete frame", async () => {
    const peer = await started();
    for (const id of [1, 2]) {
      let completed = false;
      const result = peer.capture.capture().then((encoded) => {
        completed = true;
        return encoded;
      });
      const packet = reply(id);
      for (const byte of packet.subarray(0, -1)) peer.output.write(Buffer.from([byte]));
      await Promise.resolve();
      expect(completed).toBe(false);
      peer.output.write(packet.subarray(-1));
      await expect(result).resolves.toEqual(image());
    }
    expect(peer.written.map((packet) => packet.readUInt32BE())).toEqual([1, 2]);
    expect(peer.fatal).not.toHaveBeenCalled();
    peer.capture.close();
  });

  it("refuses readiness when its handshake contains unsolicited trailing output", async () => {
    const peer = fixture();
    const rejected = expect(peer.capture.ready).rejects.toThrow("protocol");
    peer.output.write(Buffer.from("LDCPextra"));
    await rejected;
    expect(peer.capture.alive).toBe(false);
    expect(peer.fatal).toHaveBeenCalledTimes(1);
  });

  it("refuses an already-aborted capture without retiring the ready channel", async () => {
    const peer = await started();
    const cancel = new AbortController();
    cancel.abort();
    await expect(peer.capture.capture(cancel.signal)).rejects.toThrow("aborted");
    expect(peer.written).toEqual([]);
    expect(peer.capture.alive).toBe(true);
    peer.capture.close();
  });

  it("fences an active cancellation before settling and discards its late pixels", async () => {
    const peer = await started();
    const cancel = new AbortController();
    const result = peer.capture.capture(cancel.signal);
    const rejected = expect(result).rejects.toThrow("aborted");
    peer.output.write(reply(1).subarray(0, 15));
    cancel.abort();
    expect(peer.fatal).toHaveBeenCalledTimes(1);
    expect(peer.capture.alive).toBe(false);
    expect(peer.input.destroyed).toBe(true);
    expect(peer.output.destroyed).toBe(true);
    peer.output.emit("data", reply(1));
    await rejected;
    await expect(peer.capture.capture()).rejects.toThrow("closed");
  });

  it.each(["startup", "frame"] as const)("bounds a stalled %s", async (phase) => {
    vi.useFakeTimers();
    const peer = phase === "startup" ? fixture() : await started();
    const pending = phase === "startup" ? peer.capture.ready : peer.capture.capture();
    const rejected = expect(pending).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(BROWSER_CAPTURE_TIMEOUT_MS + 1);
    await rejected;
    expect(peer.capture.alive).toBe(false);
    expect(peer.fatal).toHaveBeenCalledTimes(1);
  });

  it.each([0, 2, 0xffffffff])("rejects reply identity %i", async (id) => {
    const peer = await started();
    const rejected = expect(peer.capture.capture()).rejects.toThrow("protocol");
    peer.output.write(reply(id));
    await rejected;
    expect(peer.fatal).toHaveBeenCalledTimes(1);
  });

  it.each([0, 29, MAX_BROWSER_CAPTURE_BYTES + 1, 0xffffffff])(
    "rejects size %i before reading pixels",
    async (size) => {
      const peer = await started();
      const rejected = expect(peer.capture.capture()).rejects.toThrow("protocol");
      const header = Buffer.alloc(8);
      header.writeUInt32BE(1);
      header.writeUInt32BE(size, 4);
      peer.output.write(header);
      await rejected;
      expect(peer.capture.alive).toBe(false);
    },
  );

  it.each(["magic", "length", "format", "chunk", "frame", "signature", "width", "height"])(
    "rejects invalid image %s with a fixed error",
    async (field) => {
      const peer = await started();
      const rejected = expect(peer.capture.capture()).rejects.toThrow(
        /^Browser capture refused: protocol$/u,
      );
      const encoded = image();
      const offsets: Record<string, number> = {
        magic: 0,
        length: 4,
        format: 12,
        chunk: 16,
        frame: 20,
        signature: 23,
        width: 26,
        height: 28,
      };
      const offset = offsets[field];
      if (offset === undefined) throw new Error("fixture offset missing");
      encoded[offset] = (encoded[offset] ?? 0) ^ 1;
      peer.output.write(reply(1, encoded));
      await rejected;
      expect(peer.capture.alive).toBe(false);
    },
  );

  it("rejects trailing bytes before resolving a valid image", async () => {
    const peer = await started();
    const rejected = expect(peer.capture.capture()).rejects.toThrow("protocol");
    peer.output.write(Buffer.concat([reply(1), Buffer.from([0])]));
    await rejected;
    expect(peer.fatal).toHaveBeenCalledTimes(1);
  });

  it("compares container tags as exact bytes without ASCII high-bit folding", async () => {
    const peer = await started();
    const rejected = expect(peer.capture.capture()).rejects.toThrow("protocol");
    const encoded = image();
    encoded[0] = 0xd2;
    peer.output.write(reply(1, encoded));
    await rejected;
    expect(peer.capture.alive).toBe(false);
  });

  it.each(["oversized", "text", "unsolicited", "handshake"])(
    "retires malformed %s output",
    async (mode) => {
      const peer = mode === "handshake" ? fixture() : await started();
      if (mode === "oversized")
        peer.output.emit("data", Buffer.alloc(MAX_BROWSER_CAPTURE_CHUNK + 1));
      if (mode === "text") peer.output.emit("data", "private-canary");
      if (mode === "unsolicited") peer.output.write(reply(1));
      if (mode === "handshake") peer.output.write(Buffer.from("FAIL"));
      expect(peer.capture.alive).toBe(false);
      expect(peer.fatal).toHaveBeenCalledTimes(1);
      expect(String(peer.fatal.mock.calls[0]?.[0])).not.toContain("canary");
      peer.capture.close();
      expect(peer.fatal).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["end", "error", "close"])("retires an incomplete frame on output %s", async (event) => {
    const peer = await started();
    const rejected = expect(peer.capture.capture()).rejects.toThrow("closed");
    peer.output.write(reply(1).subarray(0, 10));
    peer.output.emit(event, new Error("private-canary"));
    await rejected;
    expect(peer.capture.alive).toBe(false);
    expect(peer.fatal).toHaveBeenCalledTimes(1);
  });
});
