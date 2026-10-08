import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const validation = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined }));
vi.mock("./native-schema.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./native-schema.ts")>();
  return {
    ...original,
    nativeRequest(...args: Parameters<typeof original.nativeRequest>) {
      const captured = original.nativeRequest(...args);
      const hook = validation.hook;
      validation.hook = undefined;
      hook?.();
      return captured;
    },
  };
});

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
  return { native, requests, fatal, send };
}
afterEach(() => {
  validation.hook = undefined;
  for (const native of opened.splice(0)) native.close();
  vi.useRealTimers();
});

describe("independent corrected native admission", () => {
  it("capturing caller data never invokes an accessor that can dispatch a nested command", async () => {
    const f = fixture();
    const reads = vi.fn();
    const raw = {
      get ch() {
        reads();
        void f.native.command("ping", {}).catch(() => {});
        return "中";
      },
    };
    const command = f.native.command("char", raw);
    void command.catch(() => {});
    try {
      expect(reads).not.toHaveBeenCalled();
      expect(f.requests).toEqual([]);
      await expect(command).rejects.toThrow("command");
      expect(f.native.alive).toBe(true);
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      f.native.close();
    }
  });

  it("frozen dense arguments remain valid through reply correlation", async () => {
    const f = fixture();
    const combo = ["Shift_L", "Tab"];
    Object.freeze(combo);
    const command = f.native.command("keys", Object.freeze({ combo }));
    expect(f.requests).toEqual([{ combo: ["Shift_L", "Tab"], id: 1, cmd: "keys" }]);
    f.send({ id: 1, ok: true, keycodes: [50, 23] });
    await expect(command).resolves.toEqual({ keycodes: [50, 23] });
    expect(f.fatal).not.toHaveBeenCalled();
  });

  it("final admission preserves a nested command's single pending slot", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let nested: Promise<unknown> | undefined;
    validation.hook = () => {
      nested = f.native.command("ping", {});
      void nested.catch(() => {});
    };
    const outer = f.native.command("char", { ch: "中" });
    void outer.catch(() => {});
    try {
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]?.cmd).toBe("ping");
      f.send({ id: 1, ok: true, mono: 2 });
      await expect(nested).resolves.toEqual({ mono: 2 });
      await expect(outer).rejects.toThrow("busy");
      expect(f.native.alive).toBe(true);
    } finally {
      f.native.close();
      await vi.advanceTimersByTimeAsync(NATIVE_COMMAND_MS + 1);
    }
  });

  it("final admission after closure settles without installing orphaned work", async () => {
    vi.useFakeTimers();
    const f = fixture();
    validation.hook = () => f.native.close();
    let state = "pending";
    void f.native.command("char", { ch: "中" }).then(
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
    expect(f.fatal).toHaveBeenCalledTimes(1);
  });

  it("final admission after cancellation does not retire an undispatched channel", async () => {
    const f = fixture();
    const controller = new AbortController();
    validation.hook = () => controller.abort();
    const command = f.native.command("char", { ch: "中" }, controller.signal);
    void command.catch(() => {});
    expect(f.requests).toEqual([]);
    expect(f.fatal).not.toHaveBeenCalled();
    expect(f.native.alive).toBe(true);
    await expect(command).rejects.toThrow("aborted");
  });

  it("an exceptional validator is contained behind the fixed error contract", async () => {
    const f = fixture();
    validation.hook = () => {
      throw new Error("private-validation-canary");
    };
    let failure: unknown;
    try {
      await f.native.command("char", { ch: "中" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Browser native operation refused: command");
    expect(f.requests).toEqual([]);
    expect(f.native.alive).toBe(true);
    expect(f.fatal).not.toHaveBeenCalled();
  });
});
