import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { InputRequest, LaunchRequest, ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type CellApi, CellControlConflict } from "../cells/orchestrator.ts";
import type { Clock } from "../clock.ts";
import { DesktopdError } from "../desktopd/client.ts";
import type { DesktopdRegistry } from "../desktopd/registry.ts";
import type { EventLog } from "../event-log.ts";
import { KeyLayerError } from "../keyd/cell-wiring.ts";
import { KeydUnavailableError } from "../keyd/client.ts";
import { runPuppet } from "../puppet/runner.ts";
import { PuppetScript } from "../puppet/script.ts";
import type { FrameStore } from "./frames.ts";
import type { ActionGateway } from "./gateway.ts";
import type { KillSwitch } from "./kill-switch.ts";
import type { LiveSessions } from "./live.ts";

export interface GatewayRoutesDeps {
  registry: DesktopdRegistry;
  clock: Clock;
  eventLog?: EventLog;
  gateway?: ActionGateway;
  frames?: FrameStore;
  live?: LiveSessions;
  prepareDesktopTask?(cellId: string, sessionId: string, signal: AbortSignal): Promise<void>;
  killSwitch?: Pick<KillSwitch, "stopSession" | "resume"> & Partial<Pick<KillSwitch, "isBusy">>;
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
      const lease = deps.live?.admitIdleOperation(c.req.param("id") ?? "");
      if (deps.live && !lease) return c.text("the computer has an operation in progress", 409);
      let dispatched = false;
      let completed = false;
      try {
        const beforeClock = unavailable(c, cells, deps);
        if (beforeClock) return beforeClock;
        if (!d.clocks.sample) await d.clocks.sync();
        const beforeInput = unavailable(c, cells, deps);
        if (beforeInput) return beforeInput;
        dispatched = true;
        const result = await d.client.input(parsed.data);
        completed = true;
        // Daemon-clock microseconds (the calibration tool maps the viewer's clock onto the same
        // base); action.dispatch.pressT is session time, which only the gateway produces.
        return c.json({
          ...result,
          pressDaemonMicros: d.clocks.toDaemonMicros(result.pressMono),
          armedDaemonMicros: d.clocks.toDaemonMicros(result.armedMono),
        });
      } finally {
        // A timeout or lost reply cannot prove the native command finished. Keep that
        // computer unavailable to replacement tasks; a fresh computer has a new identity.
        if (!dispatched || completed) lease?.release();
      }
    }),
  );

  app.post("/api/cells/:id/launch", (c) =>
    withReadyCell(c, cells, deps, async (d) => {
      const parsed = LaunchRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      const lease = deps.live?.admitIdleOperation(c.req.param("id") ?? "");
      if (deps.live && !lease) return c.text("the computer has an operation in progress", 409);
      let dispatched = false;
      let completed = false;
      try {
        const beforeClock = unavailable(c, cells, deps);
        if (beforeClock) return beforeClock;
        if (!d.clocks.sample) await d.clocks.sync();
        const beforeLaunch = unavailable(c, cells, deps);
        if (beforeLaunch) return beforeLaunch;
        dispatched = true;
        const result = await d.client.launch(parsed.data);
        completed = true;
        return c.json({ ...result, armedDaemonMicros: d.clocks.toDaemonMicros(result.armedMono) });
      } finally {
        // A timeout or lost reply cannot prove the native command finished. Keep that
        // computer unavailable to replacement tasks; a fresh computer has a new identity.
        if (!dispatched || completed) lease?.release();
      }
    }),
  );

  app.post("/api/cells/:id/puppet", (c) =>
    withReadyCell(c, cells, deps, async () => {
      const { eventLog, gateway, live, registry, prepareDesktopTask } = deps;
      if (!eventLog || !gateway || !live || !prepareDesktopTask)
        return c.text("puppet not available", 503);
      const cellId = c.req.param("id") ?? "";
      const parsed = PuppetScript.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.text(parsed.error.message, 400);
      const beforeSession = unavailable(c, cells, deps);
      if (beforeSession) return beforeSession;
      if (live.get(cellId)) return c.text("a session is already live on this cell", 409);
      if (live.idleOperationPending(cellId))
        return c.text("the computer has an operation in progress", 409);
      const sessionId = eventLog.createSession(parsed.data.title);
      live.start(
        cellId,
        sessionId,
        (signal) =>
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
        (signal) => prepareDesktopTask(cellId, sessionId, signal),
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

  app.post("/api/sessions/:id/stop", async (c) => {
    const id = c.req.param("id") ?? "";
    if (!ULID_PATTERN.test(id)) return c.text("invalid session id", 400);
    if (deps.killSwitch) {
      const outcome = await deps.killSwitch.stopSession(id);
      return outcome ? c.json(outcome, 202) : c.text("no such live session", 404);
    }
    return deps.live?.stop(id) ? c.body(null, 202) : c.text("no such live session", 404);
  });

  app.post("/api/cells/:id/resume", async (c) => {
    const id = c.req.param("id") ?? "";
    if (!ULID_PATTERN.test(id)) return c.text("invalid cell id", 400);
    const cell = cells.get(id);
    if (!cell) return c.text("unknown cell", 404);
    if (cell.fenced || cell.replacementPending)
      return c.text("the computer is fenced or awaiting replacement confirmation", 409);
    if (!cell.paused) return c.text("the computer is not paused", 409);
    if (cell.state !== "ready")
      return c.text("the computer is restarting: resume it once it is ready", 409);
    if (!deps.killSwitch) return c.text("the kill switch is not available", 503);
    if (deps.killSwitch.isBusy?.(id))
      return c.text("the computer is changing state; try again", 409);
    try {
      await deps.killSwitch.resume(id);
    } catch (err) {
      if (err instanceof KeydUnavailableError || err instanceof KeyLayerError)
        return c.text("the key layer is offline: start keyd, then resume the computer", 503);
      if (err instanceof CellControlConflict) return c.text(err.message, 409);
      return c.text("the computer could not resume; try again", 502);
    }
    return c.body(null, 204);
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
  const blocked = unavailable(c, cells, deps);
  if (blocked) return blocked;
  const id = c.req.param("id") ?? "";
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

function unavailable(c: Context, cells: CellApi, deps: GatewayRoutesDeps): Response | undefined {
  const id = c.req.param("id") ?? "";
  if (!ULID_PATTERN.test(id)) return c.text("invalid cell id", 400);
  const cell = cells.get(id);
  if (!cell) return c.text("unknown cell", 404);
  if (cell.state !== "ready") return c.text(`cell is ${cell.state}`, 409);
  if (cell.fenced || cell.replacementPending)
    return c.text("the computer is fenced or awaiting replacement confirmation", 409);
  if (cell.paused) return c.text("the computer is paused: resume it first", 409);
  if (deps.killSwitch?.isBusy?.(id))
    return c.text("the computer is changing state; try again", 409);
  if (deps.live?.get(id)) return c.text("a session is already live on this cell", 409);
  return undefined;
}
