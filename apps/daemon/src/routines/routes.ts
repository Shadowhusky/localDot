import {
  keyLikePresent,
  type Routine,
  type RoutineAppEvent,
  RoutineConfirm,
  RoutineDraft,
  RoutineListReply,
  RoutineUpdate,
  type StartAtLoginState,
  type StopAllOutcome,
  ULID_PATTERN,
} from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { RoutineLauncher } from "./launch.ts";
import { parseRule, RecurrenceError } from "./recurrence.ts";
import type { RoutineScheduler } from "./scheduler.ts";
import { StartAtLoginError, type StartAtLoginPort } from "./start-at-login.ts";
import { RoutineError, type RoutineStore, type StoredRoutine, toRoutine, toRun } from "./store.ts";

export interface RoutineRoutesDeps {
  store: RoutineStore;
  scheduler: Pick<RoutineScheduler, "replan">;
  launcher: Pick<RoutineLauncher, "runNow">;
  publish(event: RoutineAppEvent): void;
  redact(text: string): string;
  zone(): string;
  now(): number;
  startAtLogin: StartAtLoginPort;
  stopAll?(by: "user" | "cli"): Promise<StopAllOutcome>;
}
const KEY_TEXT = "Recognised API keys belong in Keys, not routine text.";

export function routineRoutes(app: Hono, deps: RoutineRoutesDeps): void {
  const limit = bodyLimit({ maxSize: 64 * 1024 });
  app.use("/api/routines", limit);
  app.use("/api/routines/*", limit);
  const handle = (work: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await work(c);
    } catch (error) {
      if (error instanceof RoutineError) return c.text(error.message, error.status);
      if (error instanceof RecurrenceError) return c.text(error.message, 400);
      if (error instanceof StartAtLoginError) return c.text(error.message, 503);
      throw error;
    }
  };
  const read = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) throw new RoutineError(400, "That routine isn't valid.");
    return parsed.data;
  };
  const idOf = (c: Context) => {
    const id = c.req.param("id") ?? "";
    if (!ULID_PATTERN.test(id)) throw new RoutineError(400, "That routine id isn't valid.");
    return id;
  };
  const found = (id: string) => {
    const routine = deps.store.get(id);
    if (!routine) throw new RoutineError(404, "There is no such routine.");
    return routine;
  };
  const clean = <T extends { name?: string; instruction?: string; when?: RoutineDraft["when"] }>(
    draft: T,
  ): T => {
    for (const text of [draft.name, draft.instruction])
      if (text !== undefined && keyLikePresent(text)) throw new RoutineError(400, KEY_TEXT);
    if (draft.when?.kind === "custom") parseRule(draft.when.rule);
    return {
      ...draft,
      ...(draft.name !== undefined ? { name: deps.redact(draft.name) } : {}),
      ...(draft.instruction !== undefined ? { instruction: deps.redact(draft.instruction) } : {}),
    };
  };
  const view = (routine: StoredRoutine) => toRoutine(routine, deps.store.lastRun(routine.id));
  const changed = (routineId: string, revision: number, state: Routine["state"] | "deleted") => {
    deps.scheduler.replan();
    deps.publish({ type: "routine.changed", routineId, revision, state });
  };
  const loginState = async (): Promise<StartAtLoginState> => {
    try {
      return await deps.startAtLogin.status();
    } catch (error) {
      // A damaged record never hides the routine list.
      if (error instanceof StartAtLoginError) return "unavailable";
      throw error;
    }
  };

  app.get(
    "/api/routines",
    handle(async (c) =>
      c.json(
        RoutineListReply.parse({
          timeZone: deps.zone(),
          startAtLogin: await loginState(),
          routines: deps.store.list().map(view),
        }),
      ),
    ),
  );
  app.post(
    "/api/routines",
    handle(async (c) => {
      const routine = deps.store.create(clean(await read(c, RoutineDraft)), { state: "active" });
      changed(routine.id, routine.revision, routine.state);
      return c.json(view(found(routine.id)), 201);
    }),
  );
  app.post(
    "/api/routines/resume",
    handle(async (c) => {
      const ids = deps.store.resumeStopAll();
      for (const id of ids) {
        const routine = found(id);
        changed(id, routine.revision, routine.state);
      }
      return c.json({ resumed: ids.length });
    }),
  );
  app.get(
    "/api/routines/:id",
    handle(async (c) => c.json(view(found(idOf(c))))),
  );
  app.put(
    "/api/routines/:id",
    handle(async (c) => {
      const id = idOf(c);
      const routine = deps.store.update(id, clean(await read(c, RoutineUpdate)));
      changed(routine.id, routine.revision, routine.state);
      return c.json(view(found(id)));
    }),
  );
  app.delete(
    "/api/routines/:id",
    handle(async (c) => {
      const id = idOf(c);
      const revision = Number(c.req.query("revision"));
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new RoutineError(400, "Say which revision you are deleting.");
      deps.store.remove(id, revision);
      changed(id, revision + 1, "deleted");
      return c.body(null, 204);
    }),
  );
  app.post(
    "/api/routines/:id/confirm",
    handle(async (c) => {
      const id = idOf(c);
      const body = await read(c, RoutineConfirm);
      const routine = deps.store.confirm(
        id,
        body.revision,
        body.edits ? clean(body.edits) : undefined,
      );
      changed(routine.id, routine.revision, routine.state);
      return c.json(view(found(id)));
    }),
  );
  app.post(
    "/api/routines/:id/run",
    handle(async (c) => {
      const routine = found(idOf(c));
      if (routine.kind !== "routine" || routine.state === "proposed")
        throw new RoutineError(409, "Save this routine before running it.");
      return c.json({ runId: deps.launcher.runNow(routine) }, 202);
    }),
  );
  app.get(
    "/api/routines/:id/runs",
    handle(async (c) => {
      const id = idOf(c);
      found(id);
      const before = Date.parse(c.req.query("before") ?? "");
      const limit = Number(c.req.query("limit") ?? 50);
      const runs = deps.store.runs(id, {
        limit: Number.isSafeInteger(limit) ? limit : 50,
        ...(Number.isNaN(before) ? {} : { before }),
      });
      return c.json({ runs: runs.map(toRun) });
    }),
  );
  app.post(
    "/api/routines/:id/seen",
    handle(async (c) => {
      const id = idOf(c);
      found(id);
      deps.store.markSeen(id, deps.now());
      return c.body(null, 204);
    }),
  );

  app.get(
    "/api/start-at-login",
    handle(async (c) => c.json({ state: await deps.startAtLogin.status() })),
  );
  app.put(
    "/api/start-at-login",
    bodyLimit({ maxSize: 1024 }),
    handle(async (c) => {
      const { enabled } = await read(c, z.strictObject({ enabled: z.boolean() }));
      return c.json({ state: await deps.startAtLogin.set(enabled) });
    }),
  );

  const stopEverything = deps.stopAll;
  // Two devices (or the shortcut pressed twice) share one Stop everything instead of racing.
  let inFlight: Promise<StopAllOutcome> | undefined;
  if (stopEverything)
    app.post("/api/stop-all", bodyLimit({ maxSize: 1024 }), async (c) => {
      inFlight ??= stopEverything(c.req.query("by") === "cli" ? "cli" : "user").finally(() => {
        inFlight = undefined;
      });
      return c.json(await inFlight, 202);
    });
}
