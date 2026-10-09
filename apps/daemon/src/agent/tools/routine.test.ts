import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROXY_TOKEN, toolHarness } from "../testing/harness.ts";
import type { RoutineToolPort } from "./routine.ts";

const harnesses: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.close();
});
function port() {
  return {
    propose: vi.fn((_session: string, input: Parameters<RoutineToolPort["propose"]>[1]) => ({
      routineId: ulid(),
      revision: 1,
      name: input.name,
      summary: "Weekdays at 08:30 · London time",
      instruction: input.instruction,
      profile: input.profile ?? ("ask_first" as const),
      notify: input.notify ?? ("changes" as const),
      budgetUSD: null,
      approvalWindowMinutes: 60,
      missedPolicy: "run_once" as const,
    })),
    list: vi.fn(() => []),
    pause: vi.fn(() => true),
    followUp: vi.fn(() => ({
      routineId: ulid(),
      summary: "Once on 12 Oct 2026 at 15:00 · London time",
    })),
  } satisfies RoutineToolPort;
}

describe("routine tool", () => {
  it("propose records a card in the thread and asks for no approval", async () => {
    const routines = port();
    const h = toolHarness({ autoApprove: false, routines });
    harnesses.push(h);
    const result = await h.call("routine", {
      op: "propose",
      name: "Morning bills",
      instruction: `Use ${PROXY_TOKEN} and check statements`,
      when: { kind: "weekdays", time: "08:30" },
    });
    expect(result.body.ok).toBe(true);
    expect(result.body.content[0]?.text).toContain("Save routine");
    expect(h.events().some((e) => e.type === "approval.request")).toBe(false);
    const card = h.events().find((e) => e.type === "routine.proposed");
    expect(card?.data).toMatchObject({ name: "Morning bills", profile: "ask_first" });
    expect(JSON.stringify(card)).not.toContain(PROXY_TOKEN);
    expect(routines.propose).toHaveBeenCalledWith(
      h.session.id,
      expect.objectContaining({ name: "Morning bills" }),
    );
  });
  it("propose without a schedule is refused and records nothing", async () => {
    const routines = port();
    const h = toolHarness({ routines });
    harnesses.push(h);
    expect((await h.call("routine", { op: "propose", name: "x", instruction: "y" })).body.ok).toBe(
      false,
    );
    expect(routines.propose).not.toHaveBeenCalled();
    expect(h.events().some((e) => e.type === "routine.proposed")).toBe(false);
  });
  it("pause needs the user's approval as a settings change", async () => {
    const routines = port();
    const h = toolHarness({ routines });
    harnesses.push(h);
    const id = ulid();
    expect((await h.call("routine", { op: "pause", routine_id: id })).body.ok).toBe(true);
    const request = h.events().find((e) => e.type === "approval.request");
    expect(request?.data).toMatchObject({
      actionClass: "system_settings",
      title: "Pause a routine",
    });
    expect(routines.pause).toHaveBeenCalledWith(id);
  });
  it("follow_up_at shows when and what on the card, and does nothing when denied", async () => {
    const routines = port();
    const h = toolHarness({ autoApprove: false, routines });
    harnesses.push(h);
    const pending = h.call("follow_up_at", {
      at: "2026-10-12T15:00",
      note: "Check the parcel again",
    });
    await vi.waitFor(() => expect(h.session.pendingApproval).toBeDefined());
    const card = h.session.pendingApproval;
    expect(card?.title).toBe("Follow up later");
    expect(card?.fields).toEqual(
      expect.arrayContaining([
        ["When", "2026-10-12 15:00"],
        ["Note", "Check the parcel again"],
      ]),
    );
    h.session.answerApproval({
      approvalId: card?.approvalId,
      generation: card?.generation,
      revision: card?.revision,
      decision: "deny",
    });
    expect((await pending).body.ok).toBe(false);
    expect(routines.followUp).not.toHaveBeenCalled();
  });
  it("is unavailable without the routines port", async () => {
    const h = toolHarness();
    harnesses.push(h);
    const result = await h.call("routine", { op: "list" });
    expect(result.body.ok).toBe(false);
    expect(result.body.content[0]?.text).toBe("Routines are not available here.");
  });
});
