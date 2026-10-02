import {
  FindRequest,
  HitTestRequest,
  InputRequest,
  type InputResult,
  LaunchRequest,
  type LaunchResult,
  SettleRequest,
  TypeRequest,
  type TypeResult,
} from "@localdot/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import { bearerMatches } from "./auth.ts";
import {
  ActivationError,
  type Injectors,
  inject,
  NoPressError,
  typeText,
  UnsupportedInputError,
} from "./input.ts";
import { findTarget, focusedTarget, hitTest, type PerceptionDeps } from "./perception/hit-test.ts";
import { observe } from "./perception/observe.ts";
import { settle } from "./settle.ts";
import type { XHelper } from "./x/helper.ts";
import type { Screen, Xsettings } from "./xsettings.ts";

export type Scale = 1 | 2;

export interface DesktopdDeps {
  token: string;
  scale: Scale;
  display: string;
  // null until the session's settings can be read without disturbing its start.
  readXsettings(): Promise<Xsettings | null>;
  readScreen(): Promise<Screen | null>;
  x?: XHelper;
  injectors?: Injectors;
  launch?: (req: LaunchRequest) => { pid: number };
  clockMono?: () => number;
  perception?: PerceptionDeps;
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

export const monoNow = (): number => Number(process.hrtime.bigint()) / 1e6;

function statusOf(err: unknown): number {
  if (err instanceof NoPressError) return 504;
  if (err instanceof UnsupportedInputError) return 501;
  if (err instanceof ActivationError) return 409;
  if (err instanceof RangeError) return 400;
  return 500;
}

export function createDesktopdApp(deps: DesktopdDeps): Hono {
  const app = new Hono();
  const clock = deps.clockMono ?? monoNow;

  app.use("*", async (c, next) => {
    if (!bearerMatches(deps.token, c.req.header("authorization"))) {
      return c.text("unauthorized", 401);
    }
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 64 * 1024 }));

  app.get("/healthz", async (c) => {
    const [xsettings, screen] = await Promise.all([deps.readXsettings(), deps.readScreen()]);
    const hidpi = hidpiReport(deps.scale, xsettings);
    const want = SCREEN[deps.scale];
    const ok = hidpi.ok && screen !== null && screen.w === want.w && screen.h === want.h;
    const health: DesktopdHealth = { ok, scale: deps.scale, display: deps.display, screen, hidpi };
    return c.json(health);
  });

  app.get("/clock", (c) => c.json({ mono: clock() }));

  const withX = (fn: (x: XHelper) => Promise<Response>) => async () => {
    if (!deps.x?.alive) return new Response("x helper not available", { status: 503 });
    try {
      return await fn(deps.x);
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), {
        status: statusOf(err),
      });
    }
  };

  app.post("/input", async (c) =>
    withX(async (x) => {
      const parsed = InputRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      const result: InputResult = await inject(x, parsed.data, deps.injectors);
      return c.json(result);
    })(),
  );

  app.post("/type", async (c) =>
    withX(async (x) => {
      const parsed = TypeRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      c.header("content-type", "application/x-ndjson");
      return stream(c, async (out) => {
        // Hono's response cancellation is separate from the incoming request's signal in Node.
        const stopped = new AbortController();
        out.onAbort(() => stopped.abort());
        if (out.aborted) stopped.abort();
        const signal = AbortSignal.any([c.req.raw.signal, stopped.signal]);
        try {
          const write = async (line: unknown) => {
            signal.throwIfAborted();
            await out.write(`${JSON.stringify(line)}\n`);
          };
          const result: TypeResult = await typeText(x, parsed.data, write, deps.injectors, signal);
          await write(result);
        } catch (err) {
          if (signal.aborted) return;
          await out.write(
            `${JSON.stringify({ error: err instanceof Error ? err.message : String(err), status: statusOf(err) })}\n`,
          );
        }
      });
    })(),
  );

  app.post("/settle", async (c) =>
    withX(async (x) => {
      const parsed = SettleRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      return c.json(await settle(x, parsed.data));
    })(),
  );

  app.post("/arm", async (c) =>
    withX(async (x) => c.json(await x.call<{ mono: number }>("arm")))(),
  );

  app.post("/launch", async (c) =>
    withX(async (x) => {
      if (!deps.launch) return c.text("launch not available", 503);
      const parsed = LaunchRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      const { mono: armedMono } = await x.call<{ mono: number }>("arm");
      const result: LaunchResult = { ...deps.launch(parsed.data), armedMono };
      return c.json(result);
    })(),
  );

  const withPerception = (fn: (p: PerceptionDeps) => Promise<Response>) => async () => {
    const p = deps.perception;
    if (!p?.x.alive) return new Response("perception not available", { status: 503 });
    try {
      return await fn(p);
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), {
        status: statusOf(err),
      });
    }
  };
  app.post("/observe", (c) =>
    withPerception(async (p) => c.json(await observe({ driver: p.driver, x: p.x })))(),
  );
  app.post("/focused", (c) => withPerception(async (p) => c.json(await focusedTarget(p)))());
  app.post("/hitTest", (c) =>
    withPerception(async (p) => {
      const parsed = HitTestRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      return c.json(await hitTest(p, parsed.data.point));
    })(),
  );
  app.post("/find", (c) =>
    withPerception(async (p) => {
      const parsed = FindRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      return c.json(await findTarget(p, parsed.data));
    })(),
  );
  return app;
}
