import { type ActionClass, ulid } from "@localdot/protocol";
import { expect, it } from "vitest";
import { AgentSession } from "./session.ts";

function setup(fail?: (type: string) => boolean) {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const session = new AgentSession(ulid(), ulid(), "task", {
    append: (_id, event) => {
      if (fail?.(event.type)) throw new Error("journal unavailable");
      events.push(event);
      return event as never;
    },
  });
  const generation = session.beginBrain();
  const states = () => events.filter((e) => e.type === "agent.state").map((e) => ({ ...e.data }));
  return { session, generation, events, states };
}
function approval(
  session: AgentSession,
  generation: { id: number },
  actionClass: ActionClass = "send",
) {
  return session.requestApproval(
    {
      sessionId: session.id,
      cellId: session.cellId,
      generation: generation.id,
      callId: ulid(),
      digest: "d".repeat(64),
      targetDigest: "t".repeat(64),
    } as never,
    { actionClass, risk: "high", title: "Send the report", fields: [] },
    { signal: new AbortController().signal, check: () => {}, revalidate: async () => true },
  );
}

it("publishes that the task waits on an approval, after the request itself", () => {
  const { session, generation, events, states } = setup();
  session.setStatus("running");
  void approval(session, generation);
  expect(session.status).toBe("waiting_user");
  expect(events.map((e) => e.type)).toEqual(["approval.request", "agent.state"]);
  expect(states()).toEqual([{ state: "waiting_user", reason: "approval" }]);
});

it.each([
  ["upload", "send"],
  ["send", "send"],
  ["download_execute", "install"],
  ["system_settings", "permission"],
  ["computer", "other"],
  ["memory", "other"],
] as const)("files a %s card under the %s kind", (actionClass, kind) => {
  const { session, generation, events } = setup();
  session.setStatus("running");
  void approval(session, generation, actionClass);
  expect(events.find((e) => e.type === "approval.request")?.data).toMatchObject({
    actionClass,
    kind,
  });
});

it("keeps an approval pending when its waiting state cannot be journaled", async () => {
  const { session, generation } = setup((type) => type === "agent.state");
  session.setStatus("running");
  let settled = false;
  void approval(session, generation).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(session.pendingApproval?.title).toBe("Send the report");
});

it("publishes a user Pause once, with its reason", () => {
  const { session, states } = setup();
  session.setStatus("running");
  const requestId = ulid();
  session.requestSafetyPause(requestId);
  session.requestSafetyPause(requestId);
  expect(states()).toEqual([{ state: "paused", reason: "user" }]);
});

it("leaves a task already paused for another reason with that reason", () => {
  const { session, states } = setup();
  session.setStatus("paused");
  session.append("agent.state", { state: "paused", reason: "budget" });
  session.requestSafetyPause(ulid());
  expect(states()).toEqual([{ state: "paused", reason: "budget" }]);
});

it("still pauses when the paused state cannot be journaled", () => {
  const { session } = setup((type) => type === "agent.state");
  session.setStatus("running");
  const pause = session.requestSafetyPause(ulid());
  expect(pause.phase).toBe("pausing");
  expect(session.status).toBe("paused");
});

it("publishes a Pause once per pause, and nothing for a takeover the Pause refuses", async () => {
  const { session, events, states } = setup();
  session.setStatus("running");
  const requestId = ulid();
  session.requestSafetyPause(requestId);
  await expect(session.takeover("login", "Sign in")).rejects.toThrow("task execution paused");
  expect(session.controlHeld).toBe(false);
  session.requestSafetyPause(requestId);
  expect(states()).toEqual([{ state: "paused", reason: "user" }]);
  expect(events.some((e) => e.type === "takeover.request")).toBe(false);
});

it("reports a plain hand-back as running, and keeps a held Pause paused with no hand-off", async () => {
  const { session } = setup();
  session.setStatus("running");
  void session.takeover("other", "Finish this step").catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  expect(session.status).toBe("waiting_user");
  expect(session.endTakeover(session.pendingTakeover ?? "", undefined)).toBe(true);
  expect(session.status).toBe("running");
  const requestId = ulid();
  session.confirmSafetyPause(requestId, session.requestSafetyPause(requestId).revision);
  await expect(session.takeover("other", "Finish this step")).rejects.toThrow(
    "task execution paused",
  );
  expect(session.pendingTakeover).toBeUndefined();
  expect(session.safetyPause?.phase).toBe("paused");
  expect(session.status).toBe("paused");
});

it("holds queued messages outside the inbox, promotes exactly once, and releases the rest at task completion", async () => {
  const { session, events } = setup();
  session.setStatus("running");
  session.enqueue("First queued");
  session.enqueue("Second queued");
  const messages = events.filter((e) => e.type === "message.user");
  expect((await session.inbox(0, 0)).items).toEqual([]);
  expect(session.requests).not.toContain("First queued");
  const first = String(messages[0]?.data.messageId),
    second = String(messages[1]?.data.messageId);
  expect(session.steerQueued(first)).toBe(true);
  expect(session.steerQueued(first)).toBe(true);
  expect(
    (await session.inbox(0, 0)).items.map((item) => [item.messageId, item.kind, item.text]),
  ).toEqual([[first, "steer", "First queued"]]);
  session.setStatus("idle");
  expect(
    (await session.inbox(0, 0)).items.map((item) => [item.messageId, item.kind, item.text]),
  ).toEqual([
    [first, "steer", "First queued"],
    [second, "followup", "Second queued"],
  ]);
  expect(events.filter((e) => e.type === "message.user")).toHaveLength(2);
  expect(events.filter((e) => e.type === "message.delivery").map((e) => e.data.state)).toEqual([
    "steering",
    "sent",
  ]);
  session.stop();
});
it("Stop cancels queued follow-ups instead of launching them after the task", () => {
  const { session, events } = setup();
  session.setStatus("running");
  session.enqueue("Do this later");
  session.stop();
  expect(events.filter((e) => e.type === "message.delivery").map((e) => e.data.state)).toEqual([
    "cancelled",
  ]);
});
