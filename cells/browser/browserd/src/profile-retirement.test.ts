import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardedCdp } from "./cdp.ts";
import { CDP_RETIRE_MS, MAX_CDP_QUEUED_BYTES, pipeTransport } from "./pipe.ts";
import { BROWSER_PROCESS_STOP_MS, BROWSER_PROCESS_TERM_MS, BrowserProcesses } from "./processes.ts";
import { browserRuntimeConfig } from "./runtime-config.ts";

const capabilities = {
  downloadDir: "/tmp/downloads",
  uploadDir: "/tmp/uploads",
  ownsTarget: () => false,
  ownsSession: () => false,
  ownsWindow: () => false,
  ownsNode: () => false,
  ownsDownload: () => false,
  allowsUpload: () => false,
};

afterEach(() => vi.useRealTimers());

describe("terminal profile flush", () => {
  it("revokes normal writes and reads before issuing exactly one fixed close command", () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = new PassThrough();
    const pipe = pipeTransport(input, output);
    const observed = vi.fn();
    const closed = vi.fn(() => expect(() => pipe.write("{}")).toThrow("unavailable"));
    pipe.onMessage(observed);
    pipe.onClose(closed);
    expect(pipe.retire?.()).toBe(true);
    expect(input.read().toString()).toBe('{"id":0,"method":"Browser.close","params":{}}\0');
    expect(closed).toHaveBeenCalledTimes(1);
    output.write(Buffer.from('{"id":0,"result":{"private":"late"}}\0'));
    expect(observed).not.toHaveBeenCalled();
    expect(pipe.retire?.()).toBe(false);
    expect(input.read()).toBeNull();
    expect(() => pipe.onMessage(observed)).toThrow();
    expect(input.destroyed).toBe(false);
    vi.advanceTimersByTime(CDP_RETIRE_MS);
    expect(input.destroyed).toBe(true);
    expect(output.destroyed).toBe(true);
  });

  it("never revives a failed transport to attempt a profile flush", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pipe = pipeTransport(input, output);
    const write = vi.spyOn(input, "write");
    output.write(Buffer.from([0xff, 0]));
    expect(pipe.retire?.()).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(input.destroyed).toBe(true);
  });

  it("does not exceed the private write queue when a peer is stalled", () => {
    const input = new Writable({ write() {} });
    const output = new PassThrough();
    input.write(Buffer.alloc(MAX_CDP_QUEUED_BYTES));
    const pipe = pipeTransport(input, output);
    const write = vi.spyOn(input, "write");
    expect(pipe.retire?.()).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(input.destroyed).toBe(true);
    expect(output.destroyed).toBe(true);
  });

  it("keeps Browser.close forbidden to normal callers and cancels pending replies on retirement", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = new PassThrough();
    const pipe = pipeTransport(input, output);
    const fatal = vi.fn();
    const broker = new GuardedCdp(pipe, capabilities, fatal);
    await expect(broker.send("Browser.close")).rejects.toThrow("method");
    expect(input.read()).toBeNull();
    const pending = expect(broker.send("Browser.getVersion")).rejects.toThrow("closed");
    input.read();
    expect(broker.retire()).toBe(true);
    expect(broker.closed).toBe(true);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(input.read().toString()).toContain('"Browser.close"');
    output.write(Buffer.from('{"id":1,"result":{"private":"late"}}\0'));
    await pending;
    await expect(broker.send("Browser.getVersion")).rejects.toThrow("closed");
    expect(broker.retire()).toBe(false);
    pipe.close();
  });

  it.each(["throw", "refuse"])(
    "still closes the transport when graceful retirement fails: %s",
    (failure) => {
      const close = vi.fn();
      const retire = vi.fn(() => {
        if (failure === "throw") throw new Error("private-failure");
        return false;
      });
      const broker = new GuardedCdp(
        {
          write: vi.fn(),
          close,
          retire,
          onMessage: () => () => {},
          onClose: () => () => {},
        },
        capabilities,
        vi.fn(),
      );
      expect(broker.retire()).toBe(false);
      expect(close).toHaveBeenCalledTimes(1);
      expect(broker.closed).toBe(true);
    },
  );
});

function processes(ignoreSignals = false, graceful = () => true) {
  const config = browserRuntimeConfig({
    LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
    LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
    LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
    LOCALDOT_STREAM_TOKEN: "b".repeat(43),
    LOCALDOT_GATE_ADDR: "172.20.0.2",
    LOCALDOT_SCALE: "2",
  });
  const children = new Map<string, { alive: boolean; signals: string[] }>();
  const fence = vi.fn();
  const runtime = new BrowserProcesses(config, {
    fence,
    drain: async () => {},
    gracefulChromiumClose: graceful,
    driver: (spec) => {
      const state = { alive: true, signals: [] as string[] };
      children.set(spec.channel === "cdp" ? "chromium" : "display", state);
      return {
        started: Promise.resolve(),
        channels: {},
        get closed() {
          return !state.alive;
        },
        exists: () => state.alive,
        signal: (signal) => {
          state.signals.push(signal);
          if (!ignoreSignals) state.alive = false;
        },
      };
    },
  });
  return { runtime, children, fence };
}

describe("bounded process retirement after control revocation", () => {
  it("keeps Chromium's display alive while the profile flush finishes", async () => {
    vi.useFakeTimers();
    const test = processes();
    await test.runtime.start("display");
    await test.runtime.start("chromium");
    const done = test.runtime.stop();
    expect(test.fence).toHaveBeenCalledTimes(1);
    expect(test.runtime.closed).toBe(true);
    await expect(test.runtime.start("stream")).rejects.toThrow("closed");
    expect(test.children.get("display")?.signals).toEqual([]);
    const chrome = test.children.get("chromium");
    if (!chrome) throw new Error("missing Chromium fixture");
    chrome.alive = false;
    await vi.advanceTimersByTimeAsync(40);
    await done;
    expect(test.children.get("display")?.signals).toEqual(["SIGTERM"]);
  });

  it("falls back to termination when Chromium ignores the graceful request", async () => {
    vi.useFakeTimers();
    const test = processes();
    await test.runtime.start("chromium");
    const done = test.runtime.stop();
    await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_TERM_MS + 20);
    await done;
    expect(test.children.get("chromium")?.signals).toEqual(["SIGTERM"]);
  });

  it("force-kills unresponsive groups and refuses success when they still survive", async () => {
    vi.useFakeTimers();
    const test = processes(true);
    await test.runtime.start("chromium");
    await test.runtime.start("display");
    const done = expect(test.runtime.stop()).rejects.toThrow("shutdown");
    await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_STOP_MS + BROWSER_PROCESS_TERM_MS + 100);
    await done;
    expect(test.children.get("chromium")?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(test.children.get("display")?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(test.runtime.closed).toBe(true);
  });

  it("does not let a throwing graceful-status callback skip physical cleanup", async () => {
    const test = processes(false, () => {
      throw new Error("private-failure");
    });
    await test.runtime.start("chromium");
    await expect(test.runtime.stop()).rejects.toThrow(/^Browser runtime unavailable: shutdown$/u);
    expect(test.children.get("chromium")?.signals).toEqual(["SIGTERM"]);
  });
});
