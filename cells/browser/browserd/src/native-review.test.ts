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

describe("independent native admission boundary", () => {
  it("P1 normal scalar command completes once and allows the next explicit command", async () => {
    const f = fixture();
    const first = f.native.command("char", { ch: "中" });
    expect(f.requests).toEqual([{ ch: "中", id: 1, cmd: "char" }]);
    f.send({ id: 1, ok: true, keycode: 248, mods: [] });
    await expect(first).resolves.toEqual({ keycode: 248, mods: [] });
    const second = f.native.command("ping", {});
    f.send({ id: 2, ok: true, mono: 4 });
    await expect(second).resolves.toEqual({ mono: 4 });
    expect(f.fatal).not.toHaveBeenCalled();
  });

  it("P2 an already aborted command performs no write or fatal callback", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort("private-abort-canary");
    await expect(f.native.command("char", { ch: "中" }, abort.signal)).rejects.toThrow("aborted");
    expect(f.requests).toEqual([]);
    expect(f.fatal).not.toHaveBeenCalled();
  });

  it("argument validation cannot admit a second command while a reentrant command is pending", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let nested: Promise<unknown> | undefined;
    const args = {
      get ch() {
        nested = f.native.command("ping", {});
        void nested.catch(() => {});
        return "中";
      },
    };
    const outer = f.native.command("char", args);
    void outer.catch(() => {});
    try {
      expect(f.requests.length).toBeLessThanOrEqual(1);
      if (f.requests.length === 1) {
        f.send({ id: f.requests[0]?.id, ok: true, mono: 2 });
        await nested;
      }
    } finally {
      f.native.close();
      await vi.advanceTimersByTimeAsync(NATIVE_COMMAND_MS + 1);
    }
  });

  it("closure during argument validation cannot create an orphaned completion", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let state = "pending";
    const pending = f.native.command("char", {
      get ch() {
        f.native.close();
        return "中";
      },
    });
    void pending.then(
      () => {
        state = "resolved";
      },
      () => {
        state = "rejected";
      },
    );
    await vi.advanceTimersByTimeAsync(NATIVE_COMMAND_MS + 1);
    expect(f.requests).toEqual([]);
    expect(state).toBe("rejected");
  });

  it("a throwing argument is refused with a fixed error and no raw diagnostic", async () => {
    const f = fixture();
    let result: unknown;
    try {
      result = await f.native.command("char", {
        get ch(): string {
          throw new Error("private-text-canary");
        },
      });
    } catch (error) {
      result = error;
    }
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(
      /^Browser native operation refused: (command|closed)$/u,
    );
    expect(f.requests).toEqual([]);
  });
});
