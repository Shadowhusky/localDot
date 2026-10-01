import { Hono } from "hono";
import { bearerMatches } from "./auth.ts";
import type { Screen, Xsettings } from "./xsettings.ts";

export type Scale = 1 | 2;

export interface DesktopdDeps {
  token: string;
  scale: Scale;
  display: string;
  // null until the session's settings can be read without disturbing its start.
  readXsettings(): Promise<Xsettings | null>;
  readScreen(): Promise<Screen | null>;
}

export interface HidpiReport {
  ok: boolean;
  expected: { windowScalingFactor: Scale; xftDpi: 96 };
  windowScalingFactor: number | null;
  xftDpi: number | null;
}

export interface DesktopdHealth {
  ok: boolean;
  scale: Scale;
  display: string;
  screen: Screen | null;
  hidpi: HidpiReport;
}

const SCREEN: Record<Scale, Screen> = { 1: { w: 1280, h: 800 }, 2: { w: 2560, h: 1600 } };

// Unknown settings (null) are never ok; an unset property (a null field) is XFCE's default.
export function hidpiReport(scale: Scale, x: Xsettings | null): HidpiReport {
  const expected: HidpiReport["expected"] = { windowScalingFactor: scale, xftDpi: 96 };
  if (x === null) return { ok: false, expected, windowScalingFactor: null, xftDpi: null };
  const factor = x.windowScalingFactor ?? 1;
  const dpi = x.xftDpi ?? 96;
  return {
    ok: factor === scale && dpi === 96,
    expected,
    windowScalingFactor: x.windowScalingFactor,
    xftDpi: x.xftDpi,
  };
}

export function createDesktopdApp(deps: DesktopdDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!bearerMatches(deps.token, c.req.header("authorization"))) {
      return c.text("unauthorized", 401);
    }
    await next();
  });

  app.get("/healthz", async (c) => {
    const [xsettings, screen] = await Promise.all([deps.readXsettings(), deps.readScreen()]);
    const hidpi = hidpiReport(deps.scale, xsettings);
    const want = SCREEN[deps.scale];
    const ok = hidpi.ok && screen !== null && screen.w === want.w && screen.h === want.h;
    const health: DesktopdHealth = { ok, scale: deps.scale, display: deps.display, screen, hidpi };
    return c.json(health);
  });

  return app;
}
