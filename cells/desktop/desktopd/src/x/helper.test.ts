import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  startXHelper,
  type XEvent,
  type XHelper,
  XHelperError,
  XHelperTimeoutError,
} from "./helper.ts";

const FAKE = fileURLToPath(new URL("./testing/fake-xhelper.mjs", import.meta.url));
const helpers: XHelper[] = [];
afterEach(async () => {
  for (const h of helpers.splice(0)) await h.close();
});

async function fake(...args: string[]): Promise<XHelper> {
  const h = await startXHelper({ command: process.execPath, args: [FAKE, ...args] });
  helpers.push(h);
  return h;
}

describe("startXHelper", () => {
  it("waits for ready, answers commands by id, and delivers events to listeners", async () => {
    const h = await fake();
    const events: XEvent[] = [];
    h.onEvent((e) => events.push(e));
    const pong = await h.call<{ mono: number }>("ping");
    expect(pong.mono).toBeGreaterThan(0);
    const click = await h.call<{ presses: number }>("click", { x: 1, y: 2, button: 3 });
    expect(click.presses).toBe(1);
    expect(events.map((e) => `${e.ev}:${e.kind}:${e.detail}`)).toEqual([
      "press:button:3",
      "release:button:3",
    ]);
  });

  it("rejects with the helper's error message and keeps serving", async () => {
    const h = await fake();
    await expect(h.call("boom")).rejects.toThrow("ValueError: boom");
    expect((await h.call<{ mono: number }>("ping")).mono).toBeGreaterThan(0);
  });

  it("keeps command identity separate from supplied arguments", async () => {
    const h = await fake();
    const pong = await h.call<{ mono: number }>("ping", { id: 999, cmd: "boom" });
    expect(pong.mono).toBeGreaterThan(0);
  });

  it("times out a command that never answers", async () => {
    const h = await fake();
    await expect(h.call("hang", {}, 50)).rejects.toThrow(XHelperTimeoutError);
    await expect(h.call("boom")).rejects.not.toThrow(XHelperTimeoutError);
  });

  it("fails every pending call and reports not alive when the process exits", async () => {
    const h = await fake("--die-on-ping");
    await expect(h.call("ping")).rejects.toThrow(/exited/);
    expect(h.alive).toBe(false);
  });

  it("fails to start when the helper never says ready", async () => {
    await expect(
      startXHelper({ command: process.execPath, args: [FAKE, "--no-ready"], readyTimeoutMs: 100 }),
    ).rejects.toThrow(XHelperError);
  });
});
