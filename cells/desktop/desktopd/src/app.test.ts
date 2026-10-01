import { describe, expect, it } from "vitest";
import { createDesktopdApp, type DesktopdHealth, hidpiReport } from "./app.ts";

const TOKEN = "d".repeat(43);
const bearer = { authorization: `Bearer ${TOKEN}` };

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
