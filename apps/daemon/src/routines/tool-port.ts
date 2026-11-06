import { LocalDate, parseDateKey, type RoutineToolSchedule, zonedToUtc } from "@localdot/protocol";
import type { RoutineToolPort } from "../agent/tools/routine.ts";
import { RoutineError, type RoutineStore, type StoredRoutine, toRoutine } from "./store.ts";

const DAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// The store checks what the rule says as it checks the app's own.
export function scheduleFromTool(input: RoutineToolSchedule) {
  return {
    every: input.every ?? 1,
    unit: input.unit,
    ...(input.times ? { times: input.times } : {}),
    ...(input.days ? { weekdays: input.days.map((day) => DAY[day] as number) } : {}),
    ...(input.month_days ? { monthDays: input.month_days } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
  };
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
      const created = deps.store.create(
        {
          name: input.name,
          instruction: input.instruction,
          schedules: input.schedules.map(scheduleFromTool),
          ...(input.start ? { start: input.start } : {}),
          ...(input.until ? { until: input.until } : {}),
          ...(input.notify ? { notify: input.notify } : {}),
          ...(input.profile ? { profile: input.profile } : {}),
        },
        { state: "proposed", createdFromSession: sessionId },
      );
      deps.changed(created);
      const view = toRoutine(created, undefined, deps.now());
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
          const view = toRoutine(r, undefined, deps.now());
          return {
            id: r.id,
            name: r.name,
            summary: view.summary,
            state: r.state,
            nextDueAt: view.nextDueAt,
          };
        });
    },
    name(routineId) {
      return deps.store.get(routineId)?.name;
    },
    pause(routineId) {
      const routine = deps.store.get(routineId);
      if (routine?.kind !== "routine" || routine.state !== "active") return false;
      deps.changed(deps.store.setState(routineId, "paused", "user"));
      return true;
    },
    followUp(sessionId, at, note) {
      const [date, time] = at.split("T") as [string, string];
      if (!LocalDate.safeParse(date).success)
        throw new RoutineError(400, "That date isn't a real date.");
      const [hh, mm] = time.split(":").map(Number) as [number, number];
      const due = zonedToUtc(parseDateKey(date), hh, mm, deps.zone());
      const now = deps.now();
      if (!(due >= now + 60_000 && due <= now + 7 * 86_400_000))
        throw new RoutineError(400, "Pick a time between one minute and seven days from now.");
      const created = deps.store.create(
        {
          name: "Follow-up",
          instruction: note,
          schedules: [{ every: 1, unit: "day", times: [time] }],
          start: date,
          until: date,
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
      return {
        routineId: created.id,
        summary: toRoutine(created, undefined, deps.now()).summary,
      };
    },
  };
}
