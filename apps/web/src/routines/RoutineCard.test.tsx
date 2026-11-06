// @vitest-environment jsdom
import type { Routine, RoutineListReply } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoutineProposal } from "../agent/model.ts";
import { type RoutinesControl, useProvideRoutines } from "./context.ts";
import { PendingRoutines, RoutineCard } from "./RoutineCard.tsx";
import type { RoutinesApi } from "./routines-api.ts";
import type { RoutinesView } from "./useRoutines.ts";

afterEach(cleanup);

const SESSION = "01K7Q0000000000000000000S1";
const OTHER = "01K7Q0000000000000000000S2";
const routine = (patch: Partial<Routine> = {}): Routine => ({
  id: "01K7Q0000000000000000000R1",
  kind: "routine",
  name: "Morning bills",
  instruction: "Check statements.",
  schedules: [{ every: 1, unit: "week", weekdays: [1, 2, 3, 4, 5], times: ["08:30"] }],
  tz: "Europe/London",
  start: "2026-10-01",
  until: null,
  profile: "ask_first",
  notify: "changes",
  approvalWindowMinutes: 60,
  budgetUSD: null,
  missedPolicy: "run_once",
  state: "proposed",
  pausedReason: null,
  revision: 1,
  nextDueAt: null,
  summary: "Weekdays at 8:30 · London time",
  createdFromSession: SESSION,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  lastRun: null,
  keepAsked: false,
  ...patch,
});
const proposal = {
  id: "01K7Q0000000000000000000P1",
  routineId: routine().id,
  revision: 1,
  name: "Morning bills",
  summary: "Weekdays at 8:30 · London time",
  instruction: "Check statements.",
  profile: "ask_first",
  notify: "changes",
  budgetUSD: null,
  approvalWindowMinutes: 60,
  missedPolicy: "run_once",
} as unknown as RoutineProposal;

function Provided({ control, children }: { control: RoutinesControl; children: React.ReactNode }) {
  useProvideRoutines(control);
  return children;
}
function shown(routines: Routine[] | undefined, children: React.ReactNode) {
  const confirm = vi.fn(async () => {});
  const open = vi.fn();
  const view = {
    reply: routines && ({ routines } as unknown as RoutineListReply),
    busy: false,
    act: async (work: (api: RoutinesApi) => Promise<unknown>) => {
      await work({ confirm } as unknown as RoutinesApi);
      return true;
    },
  } as unknown as RoutinesView;
  render(<Provided control={{ view, open }}>{children}</Provided>);
  return { confirm, open };
}

describe("a routine dot drafted", () => {
  it("keeps the choice above the composer, and only a status in the thread", () => {
    shown(
      [routine()],
      <>
        <RoutineCard proposal={proposal} />
        <PendingRoutines sessions={[SESSION]} />
      </>,
    );
    const pending = screen.getByRole("region", { name: /Routine waiting for you/ });
    expect(pending.textContent).toContain("Weekdays at 8:30 · London time");
    const card = screen.getByRole("article", { name: "Routine: Morning bills" });
    expect(card.textContent).toContain("Waiting for your answer");
    expect(card.querySelectorAll("button")).toHaveLength(0);
  });
  it("saves from above the composer", () => {
    const { confirm } = shown([routine()], <PendingRoutines sessions={[SESSION]} />);
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }));
    expect(confirm).toHaveBeenCalledWith(routine().id, { revision: 1 });
  });
  it("opens Edit from above the composer", () => {
    const { open } = shown([routine()], <PendingRoutines sessions={[SESSION]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(open).toHaveBeenCalledWith(
      { mode: "confirm", id: routine().id },
      expect.any(HTMLElement),
    );
  });
  it.each([
    ["saved", [routine({ state: "active" })]],
    ["discarded", []],
    ["from another conversation", [routine({ createdFromSession: OTHER })]],
    ["not read yet", undefined],
  ])("shows nothing above the composer when %s", (_name, routines) => {
    shown(routines, <PendingRoutines sessions={[SESSION]} />);
    expect(screen.queryByRole("region")).toBeNull();
  });
  it("takes one at a time, the oldest first, and says how many wait", () => {
    shown(
      [routine(), routine({ id: "01K7Q0000000000000000000R2", name: "Evening bills" })],
      <PendingRoutines sessions={[SESSION]} />,
    );
    const pending = screen.getByRole("region", { name: /Morning bills/ });
    expect(pending.textContent).toContain("1 of 2");
    expect(screen.queryByText("Evening bills")).toBeNull();
  });
  it("says what became of it in the thread once answered", () => {
    shown(
      [routine({ state: "active", nextDueAt: "2030-01-01T09:00:00.000Z" })],
      <RoutineCard proposal={proposal} />,
    );
    expect(screen.getByRole("status").textContent).toContain("Saved · Next");
  });
  it("holds its one line while the routines are still being read", () => {
    shown(undefined, <RoutineCard proposal={proposal} />);
    expect(screen.getByRole("status").textContent).toContain("Waiting for your answer");
  });
  it("says it was discarded once it has gone", () => {
    shown([], <RoutineCard proposal={proposal} />);
    expect(screen.getByRole("status").textContent).toContain("Discarded");
  });
});
