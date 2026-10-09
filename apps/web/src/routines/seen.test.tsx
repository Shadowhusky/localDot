// @vitest-environment jsdom
import type { Routine } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "../agent/Conversation.tsx";
import type { AgentMessage } from "../agent/model.ts";
import { threadItems } from "../agent/thread.ts";
import type { ApiClient } from "../lib/api.ts";
import { RoutineSheet } from "./RoutineSheet.tsx";
import { markRoutineSeen } from "./seen.ts";
import type { RoutinesView } from "./useRoutines.ts";

vi.mock("../ui/Announcer.tsx", () => ({ announce: vi.fn(), withdraw: vi.fn() }));
afterEach(cleanup);

const ROUTINE = "01K7Q0000000000000000000R1";
const message = {
  id: "m",
  role: "assistant",
  text: "2 new statements",
  final: true,
} as AgentMessage;
const origin = (routineId: string, kind: "routine" | "follow_up" = "routine") =>
  kind === "routine"
    ? ({
        kind,
        routineId,
        runId: "01K7Q0000000000000000000N1",
        name: "Morning bills",
        dueAt: "2026-10-12T07:30:00.000Z",
      } as const)
    : ({
        kind,
        routineId,
        runId: "01K7Q0000000000000000000N1",
        sessionId: "01K7Q0000000000000000000S1",
        dueAt: "2026-10-12T07:30:00.000Z",
      } as const);
const client = () => {
  const post = vi.fn(async () => undefined);
  return { post, api: { post } as unknown as ApiClient };
};

describe("a routine counts as looked at", () => {
  it("when its thread opens, once", () => {
    const { post, api } = client();
    const id = "01K7Q0000000000000000000R2";
    const items = threadItems([message], [], [], [], [], origin(id));
    const { rerender } = render(<Conversation items={items} truncated={false} api={api} />);
    rerender(<Conversation items={[...items]} truncated={false} api={api} />);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(`/api/routines/${id}/seen`);
  });

  it("not while its thread is hidden, nor for a follow-up", () => {
    const { post, api } = client();
    const hidden = threadItems([message], [], [], [], [], origin("01K7Q0000000000000000000R3"));
    render(<Conversation items={hidden} truncated={false} api={api} visible={false} />);
    const followUp = threadItems(
      [message],
      [],
      [],
      [],
      [],
      origin("01K7Q0000000000000000000R4", "follow_up"),
    );
    render(<Conversation items={followUp} truncated={false} api={api} />);
    expect(post).not.toHaveBeenCalled();
  });

  it("at most once an hour, and again after a failed attempt", async () => {
    const seen = vi.fn(async () => {});
    markRoutineSeen(seen, ROUTINE, 0);
    markRoutineSeen(seen, ROUTINE, 3_599_999);
    expect(seen).toHaveBeenCalledTimes(1);
    markRoutineSeen(seen, ROUTINE, 3_600_000);
    expect(seen).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    const other = "01K7Q0000000000000000000R5";
    markRoutineSeen(failing, other, 0);
    await Promise.resolve();
    await Promise.resolve();
    markRoutineSeen(failing, other, 1);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("watching a run", () => {
  it("counts as looking at its routine", async () => {
    const id = "01K7Q0000000000000000000R6";
    const routine: Routine = {
      id,
      kind: "routine",
      name: "Morning bills",
      instruction: "Check statements.",
      when: { kind: "weekdays", time: "08:30" },
      tz: "Europe/London",
      until: null,
      profile: "ask_first",
      notify: "changes",
      approvalWindowMinutes: 60,
      budgetUSD: null,
      missedPolicy: "run_once",
      state: "active",
      pausedReason: null,
      revision: 1,
      nextDueAt: null,
      summary: "Weekdays at 08:30 · London time",
      createdFromSession: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      lastRun: null,
      keepAsked: false,
    };
    const session = "01K7Q0000000000000000000S2";
    const seen = vi.fn(async () => undefined);
    const routines = {
      api: {
        runs: vi.fn(async () => [
          {
            id: "01K7Q0000000000000000000N2",
            routineId: id,
            dueAt: "2026-10-12T07:30:00.000Z",
            startedAt: "2026-10-12T07:30:00.000Z",
            endedAt: "2026-10-12T07:40:00.000Z",
            sessionId: session,
            outcome: "done",
            note: "2 new statements",
          },
        ]),
        seen,
      },
      reply: { timeZone: "Europe/London", startAtLogin: "off", routines: [routine] },
      failed: false,
      problem: null,
      busy: false,
      reload: vi.fn(),
      act: vi.fn(async () => true),
      clearProblem: vi.fn(),
    } as unknown as RoutinesView;
    const onWatch = vi.fn();
    render(
      <RoutineSheet
        routines={routines}
        target={{ mode: "detail", id }}
        onClose={() => {}}
        onWatch={onWatch}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Watch" }));
    expect(seen).toHaveBeenCalledWith(id);
    expect(onWatch).toHaveBeenCalledWith(session);
  });
});
