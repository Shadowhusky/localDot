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

async function settleReview() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("independent capture ownership and retirement", () => {
  it.each(["startup", "frame"] as const)(
    "I1 listener cleanup failure cannot bypass %s fencing or completion",
    async (phase) => {
      vi.useFakeTimers();
      const peer = phase === "startup" ? fixture() : await started();
      let outcome = "pending";
      const pending = phase === "startup" ? peer.capture.ready : peer.capture.capture();
      void pending.then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );
      const badCleanup = (event: string | symbol) => {
        if (event === "data") throw new Error("private-remove-listener-canary");
      };
      peer.output.on("removeListener", badCleanup);
      try {
        try {
          peer.output.emit("data", phase === "startup" ? Buffer.from("FAIL") : reply(99));
        } catch {}
        await settleReview();
        await vi.advanceTimersByTimeAsync(BROWSER_CAPTURE_TIMEOUT_MS + 1);
        expect({
          fatalCalls: peer.fatal.mock.calls.length,
          outcome,
          alive: peer.capture.alive,
          inputDestroyed: peer.input.destroyed,
          outputDestroyed: peer.output.destroyed,
        }).toEqual({
          fatalCalls: 1,
          outcome: "rejected",
          alive: false,
          inputDestroyed: true,
          outputDestroyed: true,
        });
      } finally {
        peer.output.removeListener("removeListener", badCleanup);
        peer.capture.close();
        peer.input.destroy();
        peer.output.destroy();
        vi.clearAllTimers();
      }
    },
  );

  it("I1 a failing input destroy cannot skip independent output retirement", async () => {
    const peer = await started();
    const rejected = expect(peer.capture.capture()).rejects.toThrow("closed");
    const failed = vi.spyOn(peer.input, "destroy").mockImplementationOnce(() => {
      throw new Error("private-destroy-canary");
    });
    try {
      try {
        peer.capture.close();
      } catch {}
      await rejected;
      expect(peer.fatal).toHaveBeenCalledTimes(1);
      expect(peer.output.destroyed).toBe(true);
    } finally {
      failed.mockRestore();
      peer.input.destroy();
      peer.output.destroy();
    }
  });

  it("P1 fatal callback observes closed authority before rejection and cannot reenter or block retirement", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: Buffer[] = [];
    input.on("data", (value) => written.push(Buffer.from(value)));
    const order: string[] = [];
    let nested: Promise<Buffer> | undefined;
    let capture: BrowserCapture;
    const fatal = vi.fn(() => {
      order.push(capture.alive ? "live" : "fence");
      nested = capture.capture();
      void nested.catch(() => {});
      throw new Error("private-owner-canary");
    });
    capture = new BrowserCapture({ input, output, onFatal: fatal });
    output.write(Buffer.from("LDCP"));
    await capture.ready;
    const pending = capture.capture().catch((error) => {
      order.push("reject");
      throw error;
    });
    const rejected = expect(pending).rejects.toThrow("closed");
    output.emit("close");
    await rejected;
    await expect(nested).rejects.toThrow("closed");
    expect(order).toEqual(["fence", "reject"]);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
    expect(input.destroyed && output.destroyed).toBe(true);
    capture.close();
  });

  it("P2 completed frame owns its bytes and success detaches old cancellation", async () => {
    vi.useFakeTimers();
    const peer = await started();
    const abort = new AbortController();
    try {
      const wanted = image();
      const packet = reply(1, wanted);
      const first = peer.capture.capture(abort.signal);
      peer.output.write(packet);
      packet.fill(0);
      await expect(first).resolves.toEqual(wanted);
      abort.abort();
      await vi.advanceTimersByTimeAsync(BROWSER_CAPTURE_TIMEOUT_MS + 1);
      expect(peer.capture.alive).toBe(true);
      expect(peer.fatal).not.toHaveBeenCalled();
      const second = peer.capture.capture();
      peer.output.write(reply(2));
      await expect(second).resolves.toEqual(wanted);
      expect(peer.written.map((value) => value.readUInt32BE())).toEqual([1, 2]);
    } finally {
      peer.capture.close();
    }
  });

  it("P3 accepts the exact payload cap with bounded fragmented producer chunks", async () => {
    const peer = await started();
    const encoded = Buffer.alloc(MAX_BROWSER_CAPTURE_BYTES);
    image().copy(encoded);
    encoded.writeUInt32LE(encoded.length - 8, 4);
    encoded.writeUInt32LE(encoded.length - 20, 16);
    try {
      const pending = peer.capture.capture();
      const packet = reply(1, encoded);
      for (let offset = 0; offset < packet.length; offset += MAX_BROWSER_CAPTURE_CHUNK) {
        peer.output.write(packet.subarray(offset, offset + MAX_BROWSER_CAPTURE_CHUNK));
      }
      expect((await pending).equals(encoded)).toBe(true);
      expect(peer.capture.alive).toBe(true);
      expect(peer.fatal).not.toHaveBeenCalled();
    } finally {
      peer.capture.close();
    }
  });

  it("P4 writable finish fences active capture synchronously", async () => {
    const peer = await started();
    const pending = expect(peer.capture.capture()).rejects.toThrow("closed");
    peer.input.emit("finish");
    expect(peer.capture.alive).toBe(false);
    expect(peer.fatal).toHaveBeenCalledTimes(1);
    await pending;
  });
});
