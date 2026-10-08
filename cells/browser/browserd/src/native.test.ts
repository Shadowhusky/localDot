import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserNative,
  NATIVE_COMMAND_MS,
  NATIVE_LINE_BYTES,
  NATIVE_READY_MS,
  NATIVE_WRITE_BYTES,
} from "./native.ts";
import type { NativeArgs, NativeCommand } from "./native-schema.ts";

const opened: BrowserNative[] = [];

function setup(start = true, scale: 1 | 2 = 2, suppliedInput?: Writable) {
  const output = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  const input =
    suppliedInput ??
    new Writable({
      write(chunk, _encoding, complete) {
        requests.push(JSON.parse(chunk.toString()));
        complete();
      },
    });
  const fatal = vi.fn();
  const native = new BrowserNative({ input, output, scale, onFatal: fatal });
  opened.push(native);
  const send = (value: unknown) => output.write(Buffer.from(`${JSON.stringify(value)}\n`));
  if (start) send({ ev: "ready", mono: 100 });
  const reply = (value: object) => send({ id: requests.at(-1)?.id, ok: true, ...value });
  return { native, input, output, requests, fatal, send, reply };
}

afterEach(() => {
  for (const native of opened.splice(0)) native.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser private native protocol", () => {
  it("accepts measured surfaces without publishing native document URLs", async () => {
    const peer = setup();
    const pending = peer.native.command("surface", { window: 8 });
    const page = {
      frame: [0, 174, 2560, 1426],
      windowFrame: [0, 0, 2560, 1600],
      urlHash: "a".repeat(64),
      focus: "page",
    };
    peer.reply({ window: 8, page });
    await expect(pending).resolves.toEqual({ window: 8, page });
    expect(peer.fatal).not.toHaveBeenCalled();
  });

  it.each([
    { window: 9, page: null },
    { window: 8, page: null, url: "private" },
  ])("retires malformed or mismatched native surface replies", async (reply) => {
    const peer = setup();
    const pending = peer.native.command("surface", { window: 8 });
    const rejected = expect(pending).rejects.toThrow();
    peer.reply(reply);
    await rejected;
    expect(peer.fatal).toHaveBeenCalledOnce();
  });

  it("waits for a strict ready handshake before admitting a command", async () => {
    const peer = setup(false);
    await expect(peer.native.command("ping", {})).rejects.toThrow("closed");
    expect(peer.requests).toEqual([]);
    peer.send({ ev: "ready", mono: 10 });
    await peer.native.ready;
    const ping = peer.native.command("ping", {});
    peer.reply({ mono: 12 });
    await expect(ping).resolves.toEqual({ mono: 12 });
    expect(peer.native.alive).toBe(true);
    expect(peer.fatal).not.toHaveBeenCalled();
  });

  it("accepts split framing and complete multiple event lines without inventing presses", async () => {
    const peer = setup(false);
    const events = vi.fn();
    peer.native.onEvent(events);
    peer.output.write(Buffer.from('{"ev":"ready","mono":'));
    expect(peer.native.alive).toBe(false);
    peer.output.write(
      Buffer.from(
        '1}\n{"ev":"press","kind":"button","detail":1,"mono":2}\n{"ev":"release","kind":"button","detail":1,"mono":3}\n',
      ),
    );
    await peer.native.ready;
    expect(events.mock.calls.map(([event]) => event.ev)).toEqual(["press", "release"]);
    expect(Object.isFrozen(events.mock.calls[0]?.[0])).toBe(true);
  });

  it("does not publish startup user input before ready", async () => {
    const peer = setup(false);
    const event = vi.fn();
    peer.native.onEvent(event);
    peer.send({ ev: "press", kind: "key", detail: 38, mono: 1 });
    peer.send({ ev: "ready", mono: 2 });
    await peer.native.ready;
    expect(event).not.toHaveBeenCalled();
  });

  it("projects window geometry without exposing page titles or process metadata", async () => {
    const peer = setup();
    const pending = peer.native.command("windows", {});
    peer.reply({
      windows: [
        {
          id: 5,
          pid: 30,
          cls: "Chromium",
          title: "private canary 中文",
          x: 0,
          y: 20,
          w: 2560,
          h: 1580,
          frame: [0, 0, 2560, 1600],
          active: true,
        },
      ],
    });
    const result = await pending;
    expect(result).toEqual({ windows: [{ id: 5, frame: [0, 0, 2560, 1600], active: true }] });
    expect(JSON.stringify(result)).not.toContain("private canary");
    expect(JSON.stringify(result)).not.toContain("Chromium");
  });

  it.each([
    ["pointer", {}, { x: 10, y: 20 }],
    ["activate", { window: 5 }, { active: 5, changed: true, waitedMs: 2 }],
    ["arm", {}, { mono: 21 }],
    ["move", { x: 2559, y: 1599 }, { mono: 22 }],
    [
      "click",
      { x: 10, y: 10, count: 2, button: 1, holdMs: 0, mods: [] },
      { button: 1, presses: 2 },
    ],
    ["scroll", { x: 10, y: 10, dx: -2, dy: 3 }, { notches: 5 }],
    ["char", { ch: "中" }, { keycode: 248, mods: [] }],
    ["char", { ch: "🙂" }, { keycode: 249, mods: [] }],
    ["keys", { combo: ["Control_L", "a"] }, { keycodes: [37, 38] }],
    ["userKeys", { combo: ["Control_L", "l"] }, { keycodes: [37, 46] }],
    ["userKeys", { combo: ["F12"] }, { keycodes: [96] }],
    [
      "userKeys",
      { combo: ["Control_L", "Alt_L", "Shift_L", "Super_L", "l"] },
      { keycodes: [37, 64, 50, 133, 46] },
    ],
    [
      "userClick",
      { x: 10, y: 10, count: 1, button: 1, holdMs: 0, mods: ["Alt_L", "Super_L"] },
      { button: 1, presses: 1 },
    ],
    [
      "settle",
      { quietMs: 250, firstMs: 1500, timeoutMs: 3000 },
      { changed: [[10, 20, 40, 50]], lastChange: 30, quiet: true, noVisibleChange: false },
    ],
  ])("round-trips validated %s commands", async (command, args, reply) => {
    const peer = setup();
    const pending = peer.native.command(command as NativeCommand, args);
    expect(peer.requests).toEqual([{ ...args, id: 1, cmd: command }]);
    peer.reply(reply);
    await expect(pending).resolves.toEqual(reply);
  });

  it.each([
    ["__proto__", {}],
    ["constructor", {}],
    ["quit", {}],
    ["clearClipboard", {}],
    ["ping", { extra: "private payload" }],
    ["move", { x: 2560, y: 10 }],
    ["move", { x: 1.5, y: 10 }],
    ["click", { x: 5, y: 5, button: 1, count: 1, holdMs: 501, mods: [] }],
    ["click", { x: 5, y: 5, button: 1, count: 1, holdMs: 0, mods: ["Control_L", "Control_L"] }],
    ["scroll", { x: 5, y: 5, dx: 31, dy: 0 }],
    ["char", { ch: "two" }],
    ["char", { ch: "\0" }],
    ["char", { ch: "\ud800" }],
    ["keys", { combo: ["Control_L", "l"] }],
    ["keys", { combo: ["Alt_L", "d"] }],
    ["keys", { combo: ["F12"] }],
    ["keys", { combo: ["Control_L", "Shift_L", "i"] }],
    ["keys", { combo: ["Control_L", "o"] }],
    ["keys", { combo: ["Control_L", "s"] }],
    ["keys", { combo: ["Super_L", "r"] }],
    ["keys", { combo: ["Control_L", "Control_L", "a"] }],
    ["userKeys", { combo: ["Control_L", "Control_L", "l"] }],
    ["userKeys", { combo: ["Control_L", "Unknown"] }],
    ["userKeys", { combo: ["l", "Control_L"] }],
    ["userKeys", { combo: ["a", "b"] }],
    ["userClick", { x: 5, y: 5, button: 1, count: 1, holdMs: 1, mods: [] }],
    ["settle", { quietMs: 250, firstMs: 1500, timeoutMs: 30_001 }],
  ])("refuses invalid or privileged %s payload %j without writing", async (command, args) => {
    const peer = setup();
    await expect(
      peer.native.command(command as NativeCommand, args as NativeArgs[NativeCommand]),
    ).rejects.toThrow("command");
    expect(peer.requests).toEqual([]);
    expect(peer.native.alive).toBe(true);
    expect(peer.fatal).not.toHaveBeenCalled();
  });

  it("uses the configured physical scale to bound coordinates", async () => {
    const peer = setup(true, 1);
    await expect(peer.native.command("move", { x: 1280, y: 0 })).rejects.toThrow("command");
    const pending = peer.native.command("move", { x: 1279, y: 799 });
    peer.reply({ mono: 2 });
    await expect(pending).resolves.toEqual({ mono: 2 });
  });

  it("permits navigation and editing combinations", async () => {
    const peer = setup();
    for (const combo of [
      ["Tab"],
      ["Shift_L", "Tab"],
      ["Alt_L", "Left"],
      ["Control_L", "r"],
      ["Shift_L", "Control_L", "z"],
    ]) {
      const pending = peer.native.command("keys", { combo });
      peer.reply({ keycodes: combo.map((_, index) => 20 + index) });
      await pending;
    }
    expect(peer.requests).toHaveLength(5);
  });

  it("captures arguments and sends at most one pending command", async () => {
    const peer = setup();
    const args = { combo: ["Control_L", "a"] };
    const pending = peer.native.command("keys", args);
    args.combo.push("F12");
    await expect(peer.native.command("ping", {})).rejects.toThrow("busy");
    expect(peer.requests).toHaveLength(1);
    peer.reply({ keycodes: [37, 38] });
    await pending;
    expect(peer.requests[0]?.combo).toEqual(["Control_L", "a"]);
  });

  it("already-aborted commands have no transport or fatal effects", async () => {
    const peer = setup();
    const abort = new AbortController();
    abort.abort("private reason");
    await expect(peer.native.command("ping", {}, abort.signal)).rejects.toThrow("aborted");
    expect(peer.requests).toEqual([]);
    expect(peer.fatal).not.toHaveBeenCalled();
  });

  it("abort after dispatch fences synchronously and prevents a late reply or next command", async () => {
    const peer = setup();
    const abort = new AbortController();
    const pending = peer.native.command("char", { ch: "x" }, abort.signal);
    const rejected = expect(pending).rejects.toThrow("aborted");
    abort.abort("secret reason");
    expect(peer.fatal).toHaveBeenCalledTimes(1);
    expect(peer.native.alive).toBe(false);
    expect(peer.input.destroyed).toBe(true);
    peer.reply({ keycode: 53, mods: [] });
    await rejected;
    await expect(peer.native.command("ping", {})).rejects.toThrow("closed");
    expect(peer.requests).toHaveLength(1);
  });

  it.each(["ready", "command"])("%s deadline retires the connection", async (phase) => {
    vi.useFakeTimers();
    const peer = setup(phase === "command");
    const pending = phase === "ready" ? peer.native.ready : peer.native.command("ping", {});
    const rejected = expect(pending).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(phase === "ready" ? NATIVE_READY_MS : NATIVE_COMMAND_MS);
    await rejected;
    expect(peer.native.alive).toBe(false);
    expect(peer.fatal).toHaveBeenCalledTimes(1);
  });

  it("settle uses its bounded operation deadline plus one second", async () => {
    vi.useFakeTimers();
    const peer = setup();
    const pending = peer.native.command("settle", {
      quietMs: 250,
      firstMs: 1500,
      timeoutMs: 30_000,
    });
    const rejected = expect(pending).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(30_999);
    expect(peer.native.alive).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it.each(["end", "close", "error", "input-finish", "input-close", "input-error"])(
    "terminal channel %s rejects in-flight work",
    async (kind) => {
      const peer = setup();
      const pending = peer.native.command("ping", {});
      const rejected = expect(pending).rejects.toThrow(/closed|unavailable/u);
      if (kind.startsWith("input-"))
        peer.input.emit(kind.slice(6), new Error("private channel error"));
      else peer.output.emit(kind, new Error("private channel error"));
      await rejected;
      expect(peer.fatal).toHaveBeenCalledTimes(1);
      expect(peer.native.alive).toBe(false);
    },
  );

  it.each([
    null,
    [],
    { id: 999, ok: true, mono: 1 },
    { id: 1, ok: "true", mono: 1 },
    { id: 1, ok: true, mono: 1, unexpected: "private value" },
    { ev: "ready", mono: 2 },
    { ev: "press", kind: "key", detail: 0, mono: 1 },
    { ev: "fatal", error: "private native failure" },
  ])("malformed or unsolicited output %j fails closed", async (message) => {
    const peer = setup();
    const pending = peer.native.command("ping", {});
    const rejected = expect(pending).rejects.toThrow("protocol");
    peer.send(message);
    await rejected;
    expect(peer.native.alive).toBe(false);
    expect(peer.fatal).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["click", { x: 1, y: 1, button: 1, count: 1, holdMs: 0, mods: [] }, { button: 2, presses: 1 }],
    ["scroll", { x: 1, y: 1, dx: 1, dy: -1 }, { notches: 1 }],
    ["keys", { combo: ["Control_L", "a"] }, { keycodes: [37] }],
  ])("rejects a mismatched %s effect reply", async (command, args, reply) => {
    const peer = setup();
    const pending = peer.native.command(command as NativeCommand, args);
    const rejected = expect(pending).rejects.toThrow("protocol");
    peer.reply(reply);
    await rejected;
  });

  it("failed activation never admits follow-up input", async () => {
    const peer = setup();
    const pending = peer.native.command("activate", { window: 6 });
    const rejected = expect(pending).rejects.toThrow("protocol");
    peer.reply({ active: 5, changed: false, waitedMs: 300, timedOut: true });
    await rejected;
    await expect(peer.native.command("char", { ch: "x" })).rejects.toThrow("closed");
    expect(peer.requests).toHaveLength(1);
  });

  it("removes completed cancellation handlers and rejects duplicate replies", async () => {
    const peer = setup();
    const abort = new AbortController();
    const pending = peer.native.command("ping", {}, abort.signal);
    peer.reply({ mono: 2 });
    await pending;
    abort.abort();
    expect(peer.native.alive).toBe(true);
    peer.reply({ mono: 2 });
    expect(peer.native.alive).toBe(false);
    expect(peer.fatal).toHaveBeenCalledTimes(1);
  });

  it("never propagates helper error details or abort reasons", async () => {
    const peer = setup();
    const pending = peer.native.command("ping", {});
    const rejected = expect(pending).rejects.toThrow(
      /^Browser native operation refused: unavailable$/u,
    );
    peer.send({ id: 1, ok: false, error: "account secret token" });
    await rejected;
    expect(String(peer.fatal.mock.calls[0]?.[0])).not.toContain("account secret");
  });

  it.each(["invalid-utf8", "oversize-line", "non-buffer", "empty-line"])(
    "refuses %s framing",
    async (kind) => {
      const peer = setup(false);
      const rejected = expect(peer.native.ready).rejects.toThrow("protocol");
      if (kind === "invalid-utf8") peer.output.write(Buffer.from([0xff, 10]));
      if (kind === "oversize-line") {
        peer.output.write(Buffer.alloc(NATIVE_LINE_BYTES, 32));
        peer.output.write(Buffer.from(" \n"));
      }
      if (kind === "non-buffer") peer.output.emit("data", "wrong encoding");
      if (kind === "empty-line") peer.output.write(Buffer.from("\n"));
      await rejected;
      expect(peer.fatal).toHaveBeenCalledTimes(1);
    },
  );

  it("caps queued writes before admitting an additional command", async () => {
    const input = new Writable({ write() {} });
    input.write(Buffer.alloc(NATIVE_WRITE_BYTES));
    const peer = setup(true, 2, input);
    await expect(peer.native.command("ping", {})).rejects.toThrow("closed");
    expect(peer.fatal).toHaveBeenCalledTimes(1);
  });

  it("write failure fences pending work and keeps errors fixed", async () => {
    const peer = setup();
    vi.spyOn(peer.input, "write").mockImplementation(() => {
      throw new Error("private write error");
    });
    await expect(peer.native.command("ping", {})).rejects.toThrow(
      /^Browser native operation refused: unavailable$/u,
    );
    expect(peer.fatal).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes listeners and a thrown callback cannot leave input admitted", () => {
    const peer = setup();
    const removed = vi.fn();
    const off = peer.native.onEvent(removed);
    off();
    peer.native.onEvent(() => {
      throw new Error("listener failure");
    });
    peer.send({ ev: "press", kind: "button", detail: 1, mono: 2 });
    expect(removed).not.toHaveBeenCalled();
    expect(peer.native.alive).toBe(false);
    expect(peer.fatal).toHaveBeenCalledTimes(1);
  });
});
