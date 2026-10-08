import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_CDP_COMMAND_BYTES,
  MAX_CDP_MESSAGE_BYTES,
  MAX_CDP_QUEUED_BYTES,
  pipeTransport,
} from "./pipe.ts";

function setup() {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const pipe = pipeTransport(toChrome, fromChrome);
  const message = vi.fn();
  const closed = vi.fn();
  pipe.onMessage(message);
  pipe.onClose(closed);
  return { toChrome, fromChrome, pipe, message, closed };
}

describe("private Chromium pipe", () => {
  it("splits NUL-delimited messages across chunks without corrupting multilingual text", () => {
    const { pipe, fromChrome, message, toChrome } = setup();
    const encoded = Buffer.from('{"title":"你好"}\0{"id":2}\0');
    for (const byte of encoded) fromChrome.write(Buffer.from([byte]));
    expect(message.mock.calls).toEqual([['{"title":"你好"}'], ['{"id":2}']]);
    pipe.write('{"id":1}');
    expect(toChrome.read().toString()).toBe('{"id":1}\0');
    pipe.close();
  });

  it.each([true, false])(
    "rejects an oversized incoming message even with delimiter=%s",
    (delimited) => {
      const { pipe, fromChrome, message, closed, toChrome } = setup();
      const payload = Buffer.alloc(MAX_CDP_MESSAGE_BYTES + 1 + Number(delimited), 65);
      if (delimited) payload[payload.length - 1] = 0;
      fromChrome.write(payload);
      expect(message).not.toHaveBeenCalled();
      expect(closed).toHaveBeenCalledTimes(1);
      expect(fromChrome.destroyed).toBe(true);
      expect(toChrome.destroyed).toBe(true);
      expect(() => pipe.write("{}")).toThrow("unavailable");
    },
  );

  it("enforces the bound across fragmented input before the final delimiter", () => {
    const { fromChrome, message, closed } = setup();
    fromChrome.write(Buffer.alloc(MAX_CDP_MESSAGE_BYTES, 65));
    expect(closed).not.toHaveBeenCalled();
    fromChrome.write(Buffer.from([65, 0]));
    expect(message).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("accepts a maximum-sized message and many bounded messages in one larger chunk", () => {
    const { pipe, fromChrome, message, closed } = setup();
    const exact = Buffer.alloc(MAX_CDP_MESSAGE_BYTES + 1, 65);
    exact[exact.length - 1] = 0;
    fromChrome.write(exact);
    expect(message.mock.calls[0]?.[0].length).toBe(MAX_CDP_MESSAGE_BYTES);
    const repeated = Buffer.from(`${"A".repeat(1023)}\0`.repeat(8193));
    fromChrome.write(repeated);
    expect(message).toHaveBeenCalledTimes(8194);
    expect(closed).not.toHaveBeenCalled();
    pipe.close();
  });

  it.each([Buffer.from([0xff, 0]), Buffer.from([0])])(
    "closes on invalid UTF-8 or an empty message %#",
    (bytes) => {
      const { fromChrome, message, closed } = setup();
      fromChrome.write(bytes);
      expect(message).not.toHaveBeenCalled();
      expect(closed).toHaveBeenCalledTimes(1);
    },
  );

  it("stops delivery after a listener closes the pipe", () => {
    const { pipe, fromChrome, message } = setup();
    pipe.onMessage(() => pipe.close());
    fromChrome.write(Buffer.from('{}\0{"secret":"late"}\0'));
    expect(message).toHaveBeenCalledTimes(1);
  });

  it("contains a throwing listener and still notifies other close listeners", () => {
    const { pipe, fromChrome, closed } = setup();
    const finalClose = vi.fn();
    pipe.onMessage(() => {
      throw new Error("page details");
    });
    pipe.onClose(() => {
      throw new Error("consumer failure");
    });
    pipe.onClose(finalClose);
    fromChrome.write(Buffer.from("{}\0"));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(finalClose).toHaveBeenCalledTimes(1);
  });

  it("supports removing listeners and acknowledges late close subscriptions", () => {
    const { pipe, fromChrome } = setup();
    const removedMessage = vi.fn();
    const removedClose = vi.fn();
    pipe.onMessage(removedMessage)();
    pipe.onClose(removedClose)();
    fromChrome.write(Buffer.from("{}\0"));
    pipe.close();
    pipe.close();
    expect(removedMessage).not.toHaveBeenCalled();
    expect(removedClose).not.toHaveBeenCalled();
    const late = vi.fn();
    pipe.onClose(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(() => pipe.onMessage(vi.fn())).toThrow("unavailable");
  });

  it.each([
    "A".repeat(MAX_CDP_COMMAND_BYTES),
    "{}\0{}",
    "界".repeat(Math.ceil(MAX_CDP_COMMAND_BYTES / 3)),
  ])("refuses an oversized or delimited command %#", (command) => {
    const { pipe, closed } = setup();
    expect(() => pipe.write(command)).toThrow("unavailable");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("bounds queued writes when Chromium stops reading", () => {
    const toChrome = new Writable({ write(_chunk, _encoding, _callback) {} });
    const fromChrome = new PassThrough();
    const pipe = pipeTransport(toChrome, fromChrome);
    const command = "A".repeat(MAX_CDP_COMMAND_BYTES - 1);
    for (let count = 0; count < MAX_CDP_QUEUED_BYTES / MAX_CDP_COMMAND_BYTES; count += 1)
      pipe.write(command);
    expect(toChrome.writableLength).toBe(MAX_CDP_QUEUED_BYTES);
    expect(() => pipe.write("{}")).toThrow("unavailable");
    expect(toChrome.destroyed).toBe(true);
  });

  it("closes if Chromium ends a partial response without a delimiter", async () => {
    const { pipe, fromChrome, message, closed } = setup();
    fromChrome.end(Buffer.from('{"secret":'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(message).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(() => pipe.write("{}")).toThrow("unavailable");
  });
});
