import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { InputRequest, LaunchRequest, ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { CellApi } from "../cells/orchestrator.ts";
import type { Clock } from "../clock.ts";
import { DesktopdError } from "../desktopd/client.ts";
import type { DesktopdRegistry } from "../desktopd/registry.ts";
import type { EventLog } from "../event-log.ts";
import { runPuppet } from "../puppet/runner.ts";
import { PuppetScript } from "../puppet/script.ts";
import type { FrameStore } from "./frames.ts";
import type { ActionGateway } from "./gateway.ts";
import type { LiveSessions } from "./live.ts";

export interface GatewayRoutesDeps {
  registry: DesktopdRegistry;
  clock: Clock;
  eventLog?: EventLog;
  gateway?: ActionGateway;
  frames?: FrameStore;
  live?: LiveSessions;
}

export function gatewayRoutes(app: Hono, cells: CellApi, deps: GatewayRoutesDeps): void {
  app.get("/api/clock", (c) => c.json({ nowMicros: deps.clock.nowMicros() }));
  app.get("/api/sessions/:id/clock", (c) => {
    const id = c.req.param("id") ?? "";
    const log = deps.eventLog;
    if (!log || !ULID_PATTERN.test(id) || !log.hasSession(id))
      return c.text("unknown session", 404);
    return c.json({ originMicros: log.originOf(id), nowMicros: deps.clock.nowMicros() });
  });
  app.use("/api/cells/:id/input", bodyLimit({ maxSize: 64 * 1024 }));
  app.use("/api/cells/:id/launch", bodyLimit({ maxSize: 64 * 1024 }));
  app.use("/api/cells/:id/puppet", bodyLimit({ maxSize: 2 * 1024 * 1024 }));

  app.post("/api/cells/:id/input", (c) =>
    withReadyCell(c, cells, deps, async (d) => {
      const parsed = InputRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      if (!d.clocks.sample) await d.clocks.sync();
      const result = await d.client.input(parsed.data);
      // Daemon-clock microseconds (the calibration tool maps the viewer's clock onto the same
      // base); action.dispatch.pressT is session time, which only the gateway produces.
      return c.json({
        ...result,
        pressDaemonMicros: d.clocks.toDaemonMicros(result.pressMono),
        armedDaemonMicros: d.clocks.toDaemonMicros(result.armedMono),
      });
    }),
  );

  app.post("/api/cells/:id/launch", (c) =>
    withReadyCell(c, cells, deps, async (d) => {
      const parsed = LaunchRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      if (!d.clocks.sample) await d.clocks.sync();
      const result = await d.client.launch(parsed.data);
      return c.json({ ...result, armedDaemonMicros: d.clocks.toDaemonMicros(result.armedMono) });
    }),
  );

  app.post("/api/cells/:id/puppet", (c) =>
    withReadyCell(c, cells, deps, async () => {
      const { eventLog, gateway, live, registry } = deps;
      if (!eventLog || !gateway || !live) return c.text("puppet not available", 503);
      const cellId = c.req.param("id") ?? "";
      const parsed = PuppetScript.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      if (live.get(cellId)) return c.text("a session is already live on this cell", 409);
      const sessionId = eventLog.createSession(parsed.data.title);
      live.start(cellId, sessionId, (signal) =>
        runPuppet(
          {
            gateway,
            eventLog,
            registry,
            cells,
            sleep: (ms, s) => sleep(ms, undefined, { signal: s }),
          },
          { cellId, sessionId, script: parsed.data, signal },
        ),
      );
      return c.json({ sessionId }, 202);
    }),
  );

  app.get("/api/cells/:id/live", (c) => {
    const id = c.req.param("id") ?? "";
    if (!ULID_PATTERN.test(id)) return c.text("invalid cell id", 400);
    const sessionId = deps.live?.get(id);
    return sessionId ? c.json({ sessionId }) : c.text("no live session", 404);
  });

  app.post("/api/sessions/:id/stop", (c) => {
    const id = c.req.param("id") ?? "";
    if (!ULID_PATTERN.test(id)) return c.text("invalid session id", 400);
    return deps.live?.stop(id) ? c.body(null, 202) : c.text("no such live session", 404);
  });

  app.get("/api/sessions/:id/frames/:frameId", (c) => {
    const file = deps.frames?.path(c.req.param("id") ?? "", c.req.param("frameId") ?? "");
    if (!file) return c.text("not found", 404);
    return c.body(readFileSync(file), 200, {
      "content-type": "image/webp",
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
  });
}

export async function withReadyCell(
  c: Context,
  cells: CellApi,
  deps: GatewayRoutesDeps,
  fn: (d: NonNullable<ReturnType<DesktopdRegistry["for"]>>) => Promise<Response>,
): Promise<Response> {
  const id = c.req.param("id") ?? "";
  if (!ULID_PATTERN.test(id)) return c.text("invalid cell id", 400);
  const cell = cells.get(id);
  if (!cell) return c.text("unknown cell", 404);
  if (cell.state !== "ready") return c.text(`cell is ${cell.state}`, 409);
  const d = deps.registry.for(id);
  if (!d) return c.text("cell has no desktopd endpoint", 503);
  try {
    return await fn(d);
  } catch (err) {
    // desktopd unreachable, or refusing the daemon's own token: a bad gateway, not the caller's fault.
    if (err instanceof DesktopdError)
      return c.text(
        err.message,
        (err.status === 0 || err.status === 401 ? 502 : err.status) as ContentfulStatusCode,
      );
    throw err;
  }
}
