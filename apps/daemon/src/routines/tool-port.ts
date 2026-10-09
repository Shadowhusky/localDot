import {
  HOUR_STEPS,
  type RoutineToolWhen,
  type RoutineWhen,
  RoutineWhen as WhenSchema,
} from "@localdot/protocol";
import type { RoutineToolPort } from "../agent/tools/routine.ts";
import { parseDateKey, zonedToUtc } from "./schedule.ts";
import { RoutineError, type RoutineStore, type StoredRoutine, toRoutine } from "./store.ts";

const DAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const need = (value: string | undefined, message: string) => {
  if (!value) throw new RoutineError(400, message);
  return value;
};

export function whenFromTool(input: RoutineToolWhen): { when: RoutineWhen; until?: string } {
  let when: unknown;
  switch (input.kind) {
    case "once":
      when = {
        kind: "once",
        date: need(input.date, "A one-off routine needs date and time."),
        time: need(input.time, "A one-off routine needs date and time."),
      };
      break;
    case "daily":
    case "weekdays":
      when = { kind: input.kind, time: need(input.time, "Say what time it runs.") };
      break;
    case "weekly":
      if (!input.days?.length) throw new RoutineError(400, "A weekly routine needs days.");
      when = {
        kind: "weekly",
        days: input.days.map((d) => DAY[d]),
        time: need(input.time, "Say what time it runs."),
      };
      break;
    case "hours":
      if (!(HOUR_STEPS as readonly number[]).includes(input.every ?? 0))
        throw new RoutineError(400, "Every N hours works with 1, 2, 3, 4, 6, 8 or 12.");
      when = { kind: "hours", every: input.every, ...(input.time ? { from: input.time } : {}) };
      break;
  }
  const parsed = WhenSchema.safeParse(when);
  if (!parsed.success) throw new RoutineError(400, "That schedule isn't valid.");
  return { when: parsed.data, ...(input.until ? { until: input.until } : {}) };
}

/** What the agent's tools may do with routines: propose (inactive), list, pause, follow up. */
export function routineToolPort(deps: {
  store: RoutineStore;
  now(): number;
  zone(): string;
  changed(routine: StoredRoutine): void;
}): RoutineToolPort {
  return {
    propose(sessionId, input) {
      const { when, until } = whenFromTool(input.when);
      const created = deps.store.create(
        {
          name: input.name,
          instruction: input.instruction,
          when,
          ...(until ? { until } : {}),
          ...(input.notify ? { notify: input.notify } : {}),
          ...(input.profile ? { profile: input.profile } : {}),
        },
        { state: "proposed", createdFromSession: sessionId },
      );
      deps.changed(created);
      const view = toRoutine(created, undefined);
      return {
        routineId: created.id,
        revision: created.revision,
        name: created.name,
        summary: view.summary,
        instruction: created.instruction,
        profile: created.profile,
        notify: created.notify,
        budgetUSD: created.budgetUSD,
        approvalWindowMinutes: created.approvalWindowMinutes,
        missedPolicy: created.missedPolicy,
      };
    },
    list() {
      return deps.store
        .list()
        .filter((r) => r.state !== "finished")
        .map((r) => {
          const view = toRoutine(r, undefined);
          return {
            id: r.id,
            name: r.name,
            summary: view.summary,
            state: r.state,
            nextDueAt: view.nextDueAt,
          };
        });
    },
    pause(routineId) {
      const routine = deps.store.get(routineId);
      if (routine?.kind !== "routine" || routine.state !== "active") return false;
      deps.changed(deps.store.setState(routineId, "paused", "user"));
      return true;
    },
    followUp(sessionId, at, note) {
      const [date, time] = at.split("T") as [string, string];
      const [hh, mm] = time.split(":").map(Number) as [number, number];
      const due = zonedToUtc(parseDateKey(date), hh, mm, deps.zone());
      const now = deps.now();
      if (!(due >= now + 60_000 && due <= now + 7 * 86_400_000))
        throw new RoutineError(400, "Pick a time between one minute and seven days from now.");
      const created = deps.store.create(
        {
          name: "Follow-up",
          instruction: note,
          when: { kind: "once", date, time },
          profile: "ask_first",
        },
        {
          state: "active",
          kind: "follow_up",
          createdFromSession: sessionId,
          followUp: { sessionId, note },
        },
      );
      deps.changed(created);
      return { routineId: created.id, summary: toRoutine(created, undefined).summary };
    },
  };
}
