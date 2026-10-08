import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserNative, NATIVE_COMMAND_MS } from "./native.ts";

const opened: BrowserNative[] = [];
function fixture() {
  const requests: Record<string, unknown>[] = [];
  const output = new PassThrough();
  const input = new Writable({
    write(chunk, _encoding, done) {
      requests.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  const fatal = vi.fn();
  const native = new BrowserNative({ input, output, scale: 2, onFatal: fatal });
  opened.push(native);
  const send = (value: unknown) => output.write(Buffer.from(`${JSON.stringify(value)}\n`));
  send({ ev: "ready", mono: 1 });
  return { native, requests, output, input, fatal, send };
}
afterEach(() => {
  for (const native of opened.splice(0)) native.close();
  vi.useRealTimers();
});

describe("independent native transport security positives", () => {
  it("privileged address-bar shortcut causes zero helper writes", async () => {
    const f = fixture();
    const command = f.native.command("keys", { combo: ["Control_L", "l"] });
    void command.catch(() => {});
    try {
      expect(f.requests).toEqual([]);
      await expect(command).rejects.toThrow("command");
    } finally {
      f.native.close();
      await command.catch(() => {});
    }
  });

  it("terminal input fences authority before rejection and contains a throwing fatal callback", async () => {
    const f = fixture();
    const order: string[] = [];
    f.fatal.mockImplementation(() => {
      order.push("fenced");
      expect(f.native.alive).toBe(false);
      throw new Error("private-fatal-canary");
    });
    const result = f.native.command("ping", {}).catch((error: Error) => {
      order.push("rejected");
      return error.message;
    });
    f.input.emit("close");
    expect(order).toEqual(["fenced"]);
    await expect(result).resolves.toBe("Browser native operation refused: closed");
    expect(order).toEqual(["fenced", "rejected"]);
    expect(f.input.destroyed).toBe(true);
    expect(f.output.destroyed).toBe(true);
    await expect(f.native.command("ping", {})).rejects.toThrow("closed");
    expect(f.requests).toHaveLength(1);
  });

  it("invalid UTF-8 inside otherwise valid projected window data is never accepted", async () => {
    const f = fixture();
    const result = f.native.command("windows", {});
    const refused = expect(result).rejects.toThrow("protocol");
    const window = {
      id: 8,
      pid: 9,
      cls: "Chromium",
      title: "title-marker",
      x: 0,
      y: 0,
      w: 1280,
      h: 800,
      frame: [0, 0, 1280, 800],
      active: true,
    };
    const [before, after] = JSON.stringify({ id: 1, ok: true, windows: [window] }).split(
      "title-marker",
    );
    f.output.write(
      Buffer.concat([Buffer.from(before ?? ""), Buffer.from([255]), Buffer.from(`${after}\n`)]),
    );
    await refused;
    expect(f.native.alive).toBe(false);
  });

  it("event listener edits have snapshot semantics and closure skips later listeners", () => {
    const f = fixture();
    const seen: string[] = [];
    let remove = () => {};
    const first = () => {
      seen.push("first");
      remove();
      remove = f.native.onEvent(first);
    };
    remove = f.native.onEvent(first);
    f.native.onEvent(() => {
      seen.push("closer");
      f.native.close();
    });
    f.native.onEvent(() => seen.push("after-close"));
    f.send({ ev: "press", kind: "button", detail: 1, mono: 42.5 });
    expect(seen).toEqual(["first", "closer"]);
    expect(f.fatal).toHaveBeenCalledTimes(1);
  });

  it("a duplicate prior reply cannot complete the next pending command", async () => {
    const f = fixture();
    const first = f.native.command("ping", {});
    f.send({ id: 1, ok: true, mono: 2 });
    await first;
    const second = f.native.command("ping", {});
    const rejected = expect(second).rejects.toThrow("protocol");
    f.send({ id: 1, ok: true, mono: 2 });
    await rejected;
    expect(f.requests.map((r) => r.id)).toEqual([1, 2]);
    expect(f.native.alive).toBe(false);
  });

  it("a command deadline fences permanently and discards a later native success", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = f.native.command("click", {
      x: 20,
      y: 20,
      button: 1,
      count: 1,
      holdMs: 0,
      mods: [],
    });
    const rejected = expect(result).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(NATIVE_COMMAND_MS);
    await rejected;
    f.send({ id: 1, ok: true, button: 1, presses: 1 });
    await expect(f.native.command("char", { ch: "x" })).rejects.toThrow("closed");
    expect(f.requests).toHaveLength(1);
    expect(f.fatal).toHaveBeenCalledTimes(1);
  });
});
