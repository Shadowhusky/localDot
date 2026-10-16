import { setTimeout as sleep } from "node:timers/promises";
import {
  ElementsRequest,
  FindRequest,
  HeldResult,
  HitTestRequest,
  InputRequest,
  type InputResult,
  LaunchRequest,
  type LaunchResult,
  type SelfTestReport,
  SettleRequest,
  TypeRequest,
  type TypeResult,
  WindowControlRequest,
  ZoomRequest,
} from "@localdot/protocol";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import {
  DesktopBrowserReady,
  DesktopBrowserTask,
} from "../../../../packages/protocol/src/desktop-browser.ts";
import { WorkWindowUpdate } from "../../../../packages/protocol/src/work-window.ts";
import { bearerMatches } from "./auth.ts";
import {
  ActivationError,
  DropChangedError,
  type Injectors,
  inject,
  NoPressError,
  typeText,
  UnsupportedInputError,
} from "./input.ts";
import {
  findElements,
  findTarget,
  focusedTarget,
  hitTest,
  type PerceptionDeps,
  pageElements,
} from "./perception/hit-test.ts";
import { observe } from "./perception/observe.ts";
import { settle } from "./settle.ts";
import { addToolRoutes, type ToolRouteDeps } from "./tools/routes.ts";
import type { WorkWindow } from "./work-window.ts";
import type { XHelper } from "./x/helper.ts";
import type { Screen, Xsettings } from "./xsettings.ts";

export type Scale = 1 | 2;

export interface DesktopdDeps {
  workWindow?: Pick<WorkWindow, "update" | "hide">;
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
  selfTest?: () => Promise<SelfTestReport>;
  connectionOwner?(port: number): Promise<string | undefined>;
  tools?: ToolRouteDeps;
  prepareBrowser?(
    taskId: string,
    signal: AbortSignal,
  ): Promise<{ taskId: string | null; generation: string }>;
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
// A release waits this long at most for input still on its way, well inside the daemon's 5 s.
const LANDING_WAIT_MS = 2000;

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
  if (err instanceof ActivationError || err instanceof DropChangedError) return 409;
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
  const standardBodyLimit = bodyLimit({ maxSize: 64 * 1024 });
  app.use("*", async (c, next) => {
    if (
      [
        "/observe",
        "/input",
        "/type",
        "/find",
        "/elements",
        "/hitTest",
        "/focused",
        "/zoom",
        "/settle",
        "/release",
        "/launch",
        "/window-control",
        "/browser/navigate",
        "/browser/read",
      ].includes(c.req.path)
    )
      await deps.workWindow?.hide();
    await next();
  });
  app.use("*", (c, next) => {
    // Tool routes consume their own abort-aware, incrementally bounded request bodies. Only
    // write/edit/put have larger limits; all original routes retain the standard 64 KiB limit.
    if (
      deps.tools &&
      c.req.method === "POST" &&
      [
        "/shell",
        "/shell/stop",
        "/files/read",
        "/files/write",
        "/files/edit",
        "/files/list",
        "/files/put",
        "/files/user-upload",
        "/downloads/place",
        "/browser/read",
        "/browser/navigate",
      ].includes(c.req.path)
    )
      return next();
    return standardBodyLimit(c, next);
  });
  if (deps.tools) addToolRoutes(app, deps.tools);

  app.post("/work-window", async (c) => {
    const parsed = WorkWindowUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text("invalid display update", 400);
    if (!deps.workWindow) return c.text("display unavailable", 503);
    await deps.workWindow.update(parsed.data);
    return c.json({ ok: true });
  });

  app.post("/browser/task", async (c) => {
    const parsed = DesktopBrowserTask.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text("invalid browser task", 400);
    if (!deps.prepareBrowser) return c.text("browser task preparation is unavailable", 503);
    try {
      const receipt = DesktopBrowserReady.parse(
        await deps.prepareBrowser(parsed.data.taskId, c.req.raw.signal),
      );
      if (receipt.taskId !== parsed.data.taskId) throw new Error("task changed");
      return c.json(receipt);
    } catch {
      return c.text("desktop browser could not be prepared", 503);
    }
  });

  app.get("/selftest", async (c) => {
    const report: SelfTestReport = deps.selfTest
      ? await deps.selfTest()
      : {
          ok: false,
          checks: [
            { id: "selftest", kind: "keyd", ok: false, detail: "this desktopd has no self-test" },
          ],
          ms: 0,
        };
    return c.json(report);
  });

  app.get("/healthz", async (c) => {
    const [xsettings, screen] = await Promise.all([deps.readXsettings(), deps.readScreen()]);
    const hidpi = hidpiReport(deps.scale, xsettings);
    const want = SCREEN[deps.scale];
    const ok = hidpi.ok && screen !== null && screen.w === want.w && screen.h === want.h;
    const health: DesktopdHealth = { ok, scale: deps.scale, display: deps.display, screen, hidpi };
    return c.json(health);
  });

  app.get("/clock", (c) => c.json({ mono: clock() }));

  // Which program a connection waiting at keyd comes from, for the card that asks the user.
  app.get("/connection-owner", async (c) => {
    const port = Number(c.req.query("port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return c.text("bad port", 400);
    const owner = await deps.connectionOwner?.(port);
    return owner ? c.json({ app: owner }) : c.text("unknown", 404);
  });

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

  // NDJSON lines from `run`, then an {error, status} line if it fails. Hono's response cancellation
  // is separate from the incoming request's signal in Node: either one stops `run`.
  const ndjson = (
    c: Context,
    run: (write: (line: object) => Promise<void>, signal: AbortSignal) => Promise<void>,
  ) => {
    c.header("content-type", "application/x-ndjson");
    return stream(c, async (out) => {
      const stopped = new AbortController();
      out.onAbort(() => stopped.abort());
      if (out.aborted) stopped.abort();
      const signal = AbortSignal.any([c.req.raw.signal, stopped.signal]);
      try {
        await run(async (line) => {
          signal.throwIfAborted();
          await out.write(`${JSON.stringify(line)}\n`);
        }, signal);
      } catch (err) {
        if (signal.aborted) return;
        await out.write(
          `${JSON.stringify({ error: err instanceof Error ? err.message : String(err), status: statusOf(err) })}\n`,
        );
      }
    });
  };

  // Typing and glides send one helper command per step. A release waits for the input requests
  // still sending, which a stopped request ends at its next step, so its answer covers them.
  const landing = new Set<Promise<unknown>>();
  const land = <T>(work: Promise<T>): Promise<T> => {
    landing.add(work);
    const done = () => void landing.delete(work);
    work.then(done, done);
    return work;
  };

  app.post("/input", async (c) =>
    withX(async (x) => {
      const parsed = InputRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      const { input } = parsed.data;
      const long =
        input.kind === "drag" || (input.kind === "key" && (input.repeat || input.holdMs));
      if (!long) {
        const result: InputResult = await land(
          inject(x, parsed.data, deps.injectors, c.req.raw.signal),
        );
        return c.json(result);
      }
      // Each press is reported as it lands, so a request stopped part-way knows what was pressed.
      return ndjson(c, async (write, signal) => {
        const result = await land(inject(x, parsed.data, deps.injectors, signal, write));
        await write({ ...result, done: true });
      });
    })(),
  );

  // Every key and button the X server has down, whoever pressed them: after a Stop or a failure.
  app.post("/release", async (c) =>
    withX(async (x) => {
      const waited = new AbortController();
      await Promise.race([
        Promise.allSettled(landing),
        sleep(LANDING_WAIT_MS, undefined, { signal: waited.signal }).catch(() => undefined),
      ]);
      waited.abort();
      return c.json(await x.call<{ keys: number; buttons: number }>("release_all"));
    })(),
  );

  // Keeps the buttons the agent holds between actions down while the daemon waits on the user.
  app.post("/held", async (c) =>
    withX(async (x) => c.json(HeldResult.parse(await x.call("held"))))(),
  );

  app.post("/type", async (c) =>
    withX(async (x) => {
      const parsed = TypeRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      return ndjson(c, async (write, signal) => {
        const result: TypeResult = await land(
          typeText(x, parsed.data, write, deps.injectors, signal),
        );
        await write(result);
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

  app.post("/window-control", async (c) =>
    withX(async (x) => {
      const parsed = WindowControlRequest.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.text("invalid window operation", 400);
      if (c.req.raw.signal.aborted) return c.text("request aborted", 408);
      return c.json(await x.call("window_control", parsed.data));
    })(),
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
    withPerception(async (p) =>
      c.json(await observe({ driver: p.driver, x: p.x, screenshots: p.screenshots })),
    )(),
  );
  app.post("/zoom", (c) =>
    withPerception(async (p) => {
      const parsed = ZoomRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      const png = p.screenshots?.zoom(parsed.data.frameId, parsed.data.region);
      if (!png) return c.text("that frame is no longer kept", 404);
      return c.body(new Uint8Array(png), 200, { "content-type": "image/png" });
    })(),
  );
  app.post("/focused", (c) => withPerception(async (p) => c.json(await focusedTarget(p)))());
  app.post("/hitTest", (c) =>
    withPerception(async (p) => {
      const parsed = HitTestRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      return c.json(await hitTest(p, parsed.data.point, parsed.data.managed));
    })(),
  );
  app.post("/find", (c) =>
    withPerception(async (p) => {
      const parsed = FindRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      if (parsed.data.name === undefined && parsed.data.node === undefined)
        return c.text("find needs a name or a node", 400);
      return c.json(await findTarget(p, parsed.data));
    })(),
  );
  app.post("/elements", (c) =>
    withPerception(async (p) => {
      const parsed = ElementsRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      if (parsed.data.page) return c.json(await pageElements(p, parsed.data));
      if (parsed.data.text === undefined) return c.text("elements needs text or page", 400);
      return c.json(await findElements(p, parsed.data));
    })(),
  );
  return app;
}
