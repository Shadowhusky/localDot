import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_CAPTURE_TIMEOUT_MS, BrowserCapture } from "./capture.ts";

async function started() {
  const input = new PassThrough();
  const output = new PassThrough();
  const writes: Buffer[] = [];
  input.on("data", (chunk) => writes.push(Buffer.from(chunk)));
  const fatal = vi.fn();
  const capture = new BrowserCapture({ input, output, onFatal: fatal });
  output.write(Buffer.from("LDCP"));
  await capture.ready;
  return { input, output, writes, fatal, capture };
}

function reply() {
  const image = Buffer.alloc(30);
  image.write("RIFF", 0, "ascii");
  image.writeUInt32LE(22, 4);
  image.write("WEBPVP8 ", 8, "ascii");
  image.writeUInt32LE(10, 16);
  image.set([0x9d, 0x01, 0x2a], 23);
  image.writeUInt16LE(1280, 26);
  image.writeUInt16LE(800, 28);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(1);
  header.writeUInt32BE(image.length, 4);
  return Buffer.concat([header, image]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("scoped capture cleanup correction", () => {
  it("attempts every independent retirement after combined callback and cleanup failures", async () => {
    vi.useFakeTimers();
    const peer = await started();
    const abort = new AbortController();
    const order: string[] = [];
    const pending = peer.capture.capture(abort.signal).then(
      () => "published",
      (error: Error) => error.message,
    );
    peer.fatal.mockImplementation(() => {
      order.push("fence");
      throw new Error("private-fatal-detail");
    });
    const cleanupObserver = (event: string | symbol) => {
      if (event !== "data") return;
      order.push("unsubscribe");
      throw new Error("private-stream-detail");
    };
    peer.output.on("removeListener", cleanupObserver);
    const remove = vi.spyOn(abort.signal, "removeEventListener").mockImplementation(() => {
      order.push("abort-cleanup");
      throw new Error("private-abort-detail");
    });
    const inputDestroy = vi.spyOn(peer.input, "destroy").mockImplementation(() => {
      order.push("input-destroy");
      throw new Error("private-input-detail");
    });
    const realOutputDestroy = peer.output.destroy.bind(peer.output);
    const outputDestroy = vi.spyOn(peer.output, "destroy").mockImplementation((error) => {
      order.push("output-destroy");
      return realOutputDestroy(error);
    });
    try {
      expect(() => peer.capture.close()).not.toThrow();
      expect(await pending).toBe("Browser capture refused: closed");
      expect(order).toEqual([
        "fence",
        "unsubscribe",
        "abort-cleanup",
        "input-destroy",
        "output-destroy",
      ]);
      expect(peer.output.destroyed).toBe(true);
      await expect(peer.capture.capture()).rejects.toThrow("closed");
      abort.abort();
      peer.output.emit("data", reply());
      peer.capture.close();
      await vi.advanceTimersByTimeAsync(BROWSER_CAPTURE_TIMEOUT_MS + 1);
      expect(peer.fatal).toHaveBeenCalledTimes(1);
      expect(peer.writes).toHaveLength(1);
      expect(outputDestroy).toHaveBeenCalledTimes(1);
    } finally {
      remove.mockRestore();
      inputDestroy.mockRestore();
      outputDestroy.mockRestore();
      peer.output.removeListener("removeListener", cleanupObserver);
      peer.input.destroy();
      peer.output.destroy();
      vi.clearAllTimers();
    }
  });

  it("completion cleanup failure settles the still-owned request within its finite deadline", async () => {
    vi.useFakeTimers();
    const peer = await started();
    const abort = new AbortController();
    let outcome = "pending";
    void peer.capture.capture(abort.signal).then(
      () => {
        outcome = "published";
      },
      (error: Error) => {
        outcome = error.message;
      },
    );
    const remove = vi.spyOn(abort.signal, "removeEventListener").mockImplementation(() => {
      throw new Error("private-completion-detail");
    });
    try {
      expect(() => peer.output.emit("data", reply())).not.toThrow();
      await vi.advanceTimersByTimeAsync(BROWSER_CAPTURE_TIMEOUT_MS + 1);
      expect(outcome).toBe("Browser capture refused: closed");
      expect(peer.fatal).toHaveBeenCalledTimes(1);
      expect(peer.input.destroyed && peer.output.destroyed).toBe(true);
    } finally {
      remove.mockRestore();
      peer.capture.close();
      peer.input.destroy();
      peer.output.destroy();
      vi.clearAllTimers();
    }
  });

  it("reentrant close from successful cleanup never publishes pixels or admits another request", async () => {
    const peer = await started();
    const abort = new AbortController();
    const pending = peer.capture.capture(abort.signal).then(
      () => "published",
      (error: Error) => error.message,
    );
    const realRemove = abort.signal.removeEventListener.bind(abort.signal);
    const remove = vi.spyOn(abort.signal, "removeEventListener").mockImplementation((...args) => {
      realRemove(...args);
      peer.capture.close();
    });
    try {
      peer.output.emit("data", reply());
      expect(await pending).toBe("Browser capture refused: closed");
      expect(peer.fatal).toHaveBeenCalledTimes(1);
      expect(peer.input.destroyed && peer.output.destroyed).toBe(true);
      await expect(peer.capture.capture()).rejects.toThrow("closed");
      expect(peer.writes).toHaveLength(1);
    } finally {
      remove.mockRestore();
      peer.capture.close();
    }
  });
});
