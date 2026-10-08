import { describe, expect, it } from "vitest";
import { createDesktopdApp, type DesktopdHealth, hidpiReport } from "./app.ts";
import type { XEvent, XHelper } from "./x/helper.ts";

const TOKEN = "d".repeat(43);
const bearer = { authorization: `Bearer ${TOKEN}` };
describe("desktopd self-test route", () => {
  it("serves the self-test behind the cell token, and fails without one wired", async () => {
    const report = {
      ok: true,
      checks: [{ id: "route", kind: "isolation" as const, ok: true, detail: "no default route" }],
      ms: 3,
    };
    const wired = createDesktopdApp({
      token: TOKEN,
      scale: 2,
      display: ":1",
      readXsettings: async () => ({ windowScalingFactor: 2, xftDpi: 96 }),
      readScreen: async () => ({ w: 2560, h: 1600 }),
      selfTest: async () => report,
    });
    expect((await wired.request("/selftest")).status).toBe(401);
    expect(await (await wired.request("/selftest", { headers: bearer })).json()).toEqual(report);
    const bare = app({ scale: 2, factor: 2, dpi: 96, screen: { w: 2560, h: 1600 } });
    expect(await (await bare.request("/selftest", { headers: bearer })).json()).toMatchObject({
      ok: false,
    });
  });
});

function app(opts: {
  scale: 1 | 2;
  factor: number | null;
  dpi: number | null;
  screen: { w: number; h: number } | null;
}) {
  return createDesktopdApp({
    token: TOKEN,
    scale: opts.scale,
    display: ":1",
    readXsettings: async () => ({ windowScalingFactor: opts.factor, xftDpi: opts.dpi }),
    readScreen: async () => opts.screen,
  });
}

describe("desktopd health", () => {
  it("refuses requests without the cell token", async () => {
    const a = app({ scale: 2, factor: 2, dpi: 96, screen: { w: 2560, h: 1600 } });
    expect((await a.request("/healthz")).status).toBe(401);
    expect(
      (await a.request("/healthz", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
    expect(
      (await a.request("/healthz", { headers: { authorization: `Basic ${TOKEN}` } })).status,
    ).toBe(401);
  });

  it("refuses a wrong token of the right length", async () => {
    const a = app({ scale: 2, factor: 2, dpi: 96, screen: { w: 2560, h: 1600 } });
    const wrong = `Bearer ${"e".repeat(TOKEN.length)}`;
    expect((await a.request("/healthz", { headers: { authorization: wrong } })).status).toBe(401);
  });

  it("reports ok at 2x with window scaling 2, Xft/DPI 96 and a 2560x1600 screen", async () => {
    const res = await app({ scale: 2, factor: 2, dpi: 96, screen: { w: 2560, h: 1600 } }).request(
      "/healthz",
      { headers: bearer },
    );
    expect(res.status).toBe(200);
    const health = (await res.json()) as DesktopdHealth;
    expect(health).toEqual({
      ok: true,
      scale: 2,
      display: ":1",
      screen: { w: 2560, h: 1600 },
      hidpi: {
        ok: true,
        expected: { windowScalingFactor: 2, xftDpi: 96 },
        windowScalingFactor: 2,
        xftDpi: 96,
      },
    });
  });

  it("reports the HiDPI mismatch when XFCE did not scale", async () => {
    const res = await app({ scale: 2, factor: 1, dpi: 192, screen: { w: 2560, h: 1600 } }).request(
      "/healthz",
      { headers: bearer },
    );
    const health = (await res.json()) as DesktopdHealth;
    expect(health.ok).toBe(false);
    expect(health.hidpi).toEqual({
      ok: false,
      expected: { windowScalingFactor: 2, xftDpi: 96 },
      windowScalingFactor: 1,
      xftDpi: 192,
    });
  });

  it("reports not ok when the screen has the wrong size or is unreadable", async () => {
    const wrong = await app({ scale: 2, factor: 2, dpi: 96, screen: { w: 1280, h: 800 } }).request(
      "/healthz",
      { headers: bearer },
    );
    expect(((await wrong.json()) as DesktopdHealth).ok).toBe(false);
    const none = await app({ scale: 2, factor: 2, dpi: 96, screen: null }).request("/healthz", {
      headers: bearer,
    });
    expect(((await none.json()) as DesktopdHealth).ok).toBe(false);
  });

  it("treats unset xsettings as 1x at 96 dpi", () => {
    expect(hidpiReport(1, { windowScalingFactor: null, xftDpi: null }).ok).toBe(true);
    expect(hidpiReport(2, { windowScalingFactor: null, xftDpi: null }).ok).toBe(false);
  });

  it("reports not ready, at either scale, while the session's xsettings are unknown", async () => {
    for (const [scale, screen] of [
      [1, { w: 1280, h: 800 }],
      [2, { w: 2560, h: 1600 }],
    ] as const) {
      const notReady = createDesktopdApp({
        token: TOKEN,
        scale,
        display: ":1",
        readXsettings: async () => null,
        readScreen: async () => screen,
      });
      const res = await notReady.request("/healthz", { headers: bearer });
      expect(res.status).toBe(200);
      expect((await res.json()) as DesktopdHealth).toEqual({
        ok: false,
        scale,
        display: ":1",
        screen,
        hidpi: {
          ok: false,
          expected: { windowScalingFactor: scale, xftDpi: 96 },
          windowScalingFactor: null,
          xftDpi: null,
        },
      });
    }
  });
});

function fakeX(): XHelper & {
  emit(e: XEvent): void;
  calls: string[];
  args: Record<string, unknown>[];
} {
  const listeners = new Set<(e: XEvent) => void>();
  const calls: string[] = [];
  const args: Record<string, unknown>[] = [];
  let mono = 100;
  return {
    alive: true,
    calls,
    args,
    emit: (e) => {
      for (const l of listeners) l(e);
    },
    async call(cmd, sent = {}) {
      calls.push(cmd);
      args.push(sent);
      mono += 1;
      if (cmd === "ping" || cmd === "arm" || cmd === "move") return { mono } as never;
      if (cmd === "click") {
        for (const l of listeners)
          l({ ev: "press", kind: "button", detail: Number(sent.button), mono });
        return { button: sent.button, presses: 1 } as never;
      }
      if (cmd === "char") {
        for (const l of listeners) l({ ev: "press", kind: "key", detail: 30, mono });
        return { keycode: 30, mods: [] } as never;
      }
      if (cmd === "hold") {
        for (const l of listeners) l({ ev: "press", kind: "key", detail: 50, mono });
        return { keycodes: [50] } as never;
      }
      if (cmd === "release") return { keycodes: [50] } as never;
      if (cmd === "release_all") return { keys: 2, buttons: 1 } as never;
      if (cmd === "settle")
        return {
          changed: [[1, 2, 3, 4]],
          lastChange: mono,
          quiet: true,
          noVisibleChange: false,
        } as never;
      return {} as never;
    },
    onEvent(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async close() {},
  };
}

function fullApp(x: XHelper) {
  return createDesktopdApp({
    token: TOKEN,
    scale: 2,
    display: ":1",
    readXsettings: async () => ({ windowScalingFactor: 2, xftDpi: 96 }),
    readScreen: async () => ({ w: 2560, h: 1600 }),
    x,
    launch: (req) => ({ pid: 999 + req.args.length }),
    clockMono: () => 42.5,
  });
}

describe("desktopd input routes", () => {
  it("stops typing when its response stream is cancelled", async () => {
    const x = fakeX();
    const a = fullApp(x);
    const res = await a.request("/type", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({
        text: "abcdef",
        masked: false,
        pace: { firstMs: 100, firstCount: 60, restMs: 0 },
      }),
    });
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.cancel();
    await new Promise((r) => setTimeout(r, 150));
    expect(x.calls.filter((cmd) => cmd === "char")).toHaveLength(1);
  });
  it("bounds authenticated request bodies before parsing or injecting", async () => {
    const x = fakeX();
    const res = await fullApp(x).request("/type", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(70_000) }),
    });
    expect(res.status).toBe(413);
    expect(x.calls).toHaveLength(0);
  });
  it("answers the clock and injects a click with the raw press time", async () => {
    const a = fullApp(fakeX());
    expect(await (await a.request("/clock", { headers: bearer })).json()).toEqual({ mono: 42.5 });
    const res = await a.request("/input", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({
        input: { kind: "click", button: "left", count: 1, at: { x: 1, y: 2 } },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      pressMono: expect.any(Number),
      presses: [expect.any(Number)],
      injector: "xtest",
    });
  });

  it("rejects bad bodies, unsupported kinds and reports a missing press as 504", async () => {
    const x = fakeX();
    x.call = (async (cmd: string) => (cmd === "arm" ? { mono: 1 } : { presses: 1 })) as never;
    const a = fullApp(x);
    const post = (body: unknown) =>
      a.request("/input", {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ input: { kind: "teleport" } })).status).toBe(400);
    expect(
      (await post({ input: { kind: "drag", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } } })).status,
    ).toBe(501);
    expect(
      (await post({ input: { kind: "click", button: "left", count: 1, at: { x: 1, y: 2 } } }))
        .status,
    ).toBe(504);
  });

  it("streams typing progress as NDJSON and ends with the result", async () => {
    const a = fullApp(fakeX());
    const res = await a.request("/type", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({
        text: "hi",
        masked: false,
        pace: { firstMs: 0, firstCount: 60, restMs: 0 },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.count)).toEqual([1, 2, 2]);
    expect(lines[0]).toMatchObject({ chunk: "h" });
    expect(lines[2]).toMatchObject({ done: true, count: 2, injector: "xtest" });
  });

  it("settles, arms and launches", async () => {
    const x = fakeX();
    const a = fullApp(x);
    const settled = await a.request("/settle", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: "{}",
    });
    expect(await settled.json()).toMatchObject({
      changed: [{ x: 1, y: 2, w: 3, h: 4 }],
      quiet: true,
      noVisibleChange: false,
    });
    await a.request("/settle", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ verb: "key", firstMs: 400, quietMs: 250, timeoutMs: 3000 }),
    });
    expect(x.args[x.calls.lastIndexOf("settle")]).toEqual({
      verb: "key",
      firstMs: 400,
      quietMs: 250,
      timeoutMs: 3000,
    });
    expect(
      (
        await a.request("/settle", {
          method: "POST",
          headers: { ...bearer, "content-type": "application/json" },
          body: JSON.stringify({ verb: "drag" }),
        })
      ).status,
    ).toBe(400);
    expect((await a.request("/arm", { method: "POST", headers: bearer })).status).toBe(200);
    const launched = await a.request("/launch", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ app: "terminal" }),
    });
    expect(await launched.json()).toMatchObject({ pid: 999, armedMono: expect.any(Number) });
    expect(
      (
        await a.request("/launch", {
          method: "POST",
          headers: { ...bearer, "content-type": "application/json" },
          body: JSON.stringify({ app: "bash" }),
        })
      ).status,
    ).toBe(400);
  });

  it("releases held keys when the request that holds them is stopped", async () => {
    const x = fakeX();
    const stop = new AbortController();
    const holding = fullApp(x).request("/input", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ input: { kind: "key", combo: ["shift"], holdMs: 10_000 } }),
      signal: stop.signal,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(x.calls).toEqual(["arm", "hold"]);
    stop.abort();
    await Promise.resolve(holding).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(x.calls).toEqual(["arm", "hold", "release"]);
  });

  it("releases every key and button that is down", async () => {
    const x = fakeX();
    const res = await fullApp(x).request("/release", { method: "POST", headers: bearer });
    expect(await res.json()).toMatchObject({ keys: 2, buttons: 1 });
    expect(x.calls).toEqual(["release_all"]);
  });

  it("answers an unknown key name with 400 and its close matches", async () => {
    const x = fakeX();
    const res = await fullApp(x).request("/input", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ input: { kind: "key", combo: ["ctrl", "Retrun"] } }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/unknown key "Retrun"; did you mean Return/);
    expect(x.calls).toEqual([]);
  });

  it("answers 503 on the input routes when the helper is missing", async () => {
    const a = app({ scale: 2, factor: 2, dpi: 96, screen: { w: 2560, h: 1600 } });
    expect(
      (
        await a.request("/input", {
          method: "POST",
          headers: { ...bearer, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(503);
    expect((await a.request("/settle", { method: "POST", headers: bearer })).status).toBe(503);
  });
});

describe("desktopd zoom", () => {
  const frameId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
  function zoomApp(zoom: (id: string, region: unknown) => Buffer | undefined) {
    return createDesktopdApp({
      token: TOKEN,
      scale: 2,
      display: ":1",
      readXsettings: async () => ({ windowScalingFactor: 2, xftDpi: 96 }),
      readScreen: async () => ({ w: 2560, h: 1600 }),
      perception: {
        x: fakeX(),
        driver: {} as never,
        screenshots: { zoom } as never,
        scale: 2,
        readScaling: async () => 2,
      },
    });
  }
  const post = (a: ReturnType<typeof zoomApp>, body: unknown) =>
    a.request("/zoom", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("returns the kept frame's region as PNG and 404 once the frame is gone", async () => {
    const asked: unknown[] = [];
    const a = zoomApp((id, region) => {
      asked.push([id, region]);
      return id === frameId ? Buffer.from("png") : undefined;
    });
    const region = { x: 10, y: 20, w: 30, h: 40 };
    const res = await post(a, { frameId, region });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("png");
    expect((await post(a, { frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0P", region })).status).toBe(404);
    expect(asked).toEqual([
      [frameId, region],
      ["01J9ZQ3V8Y7X6W5T4S3R2Q1P0P", region],
    ]);
  });

  it("refuses a malformed request before reading any frame", async () => {
    const a = zoomApp(() => {
      throw new Error("must not be asked");
    });
    expect((await post(a, { frameId: "../x", region: { x: 0, y: 0, w: 8, h: 8 } })).status).toBe(
      400,
    );
    expect((await post(a, { frameId })).status).toBe(400);
    expect((await a.request("/zoom", { method: "POST", body: "{}" })).status).toBe(401);
  });
});
