import { CAREFUL_AUTONOMY, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolHarness } from "../testing/harness.ts";

const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const h of fixtures.splice(0)) h.close();
});
function setup(options?: Parameters<typeof toolHarness>[0]) {
  const h = toolHarness(options);
  fixtures.push(h);
  return h;
}
const waiting = {
  summary: "The match is not finished; another player is taking their turn.",
  completion: { status: "waiting", evidence: "Round 1; another player's turn", wait_seconds: 15 },
  input_request: null,
};
const text = (result: { content: { text?: string }[] }) =>
  result.content.map((part) => part.text ?? "").join("\n");
function heldSleep(h: ReturnType<typeof setup>) {
  const held = Promise.withResolvers<void>();
  // The runtime must fence even a dependency that ignores cancellation.
  const sleep = vi.fn(async () => held.promise);
  h.tools.sleep = sleep;
  return { sleep, release: () => held.resolve() };
}

describe("completion waits for external progress", () => {
  it("keeps unchanged waits active, with no result, files, lessons or screen requirement", async () => {
    const h = setup();
    const sleep = vi.spyOn(h.tools, "sleep");
    const desktop = vi.spyOn(h.tools, "desktop").mockReturnValue(undefined);
    const save = vi.spyOn(h.tools, "saveOutput");
    const lesson = vi.fn();
    h.tools.saveExperience = lesson;
    for (let n = 0; n < 3; n++) {
      const result = await h.call("done", {
        ...waiting,
        files: ["not-yet-produced.txt"],
        experience: { scope: "game", when: "waiting", procedure: "keep waiting", recheck: "turn" },
      });
      expect(result.body).toMatchObject({ ok: true });
      expect(result.body.final).not.toBe(true);
      expect(text(result.body)).toContain("task remains active and unfinished");
      expect(h.session.status).toBe("running");
    }
    expect(sleep).toHaveBeenCalledTimes(45);
    expect(sleep.mock.calls.every(([ms]) => ms === 1000)).toBe(true);
    expect(desktop).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(lesson).not.toHaveBeenCalled();
    expect(h.events().some((e) => e.type === "task.result" || e.type === "step.verify")).toBe(
      false,
    );
    expect(h.actions).toHaveLength(0);
    const done = await h.call("done", {
      summary: "The match reached its final results.",
      completion: { status: "complete", evidence: "Game-over screen and final scores visible" },
      input_request: null,
    });
    expect(done.body).toMatchObject({ ok: true, final: true });
    const results = h.events().filter((e) => e.type === "task.result");
    expect(results).toHaveLength(1);
    expect(results[0]?.data).toMatchObject({ outcome: "complete" });
  });

  it.each([1, 30, undefined])(
    "bounds a wait of %s seconds and defaults to 15 seconds",
    async (seconds) => {
      const h = setup();
      const sleep = vi.spyOn(h.tools, "sleep");
      const result = await h.call("done", {
        ...waiting,
        completion: { ...waiting.completion, wait_seconds: seconds },
      });
      expect(result.body.ok).toBe(true);
      expect(result.body.final).not.toBe(true);
      expect(sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0)).toBe((seconds ?? 15) * 1000);
    },
  );

  it.each([0, 31, -1, 1.5])("rejects invalid wait duration %s before waiting", async (seconds) => {
    const h = setup();
    const sleep = vi.spyOn(h.tools, "sleep");
    const result = await h.call("done", {
      ...waiting,
      completion: { ...waiting.completion, wait_seconds: seconds },
    });
    expect(result.status).toBe(400);
    expect(sleep).not.toHaveBeenCalled();
    expect(h.events().some((e) => e.type === "task.result")).toBe(false);
  });

  it.each(["x".repeat(500), "界".repeat(500)])(
    "bounds long waiting evidence in the activity log",
    async (evidence) => {
      const h = setup();
      const result = await h.call("done", {
        ...waiting,
        completion: { ...waiting.completion, evidence, wait_seconds: 1 },
      });
      expect(result.body).toMatchObject({ ok: true });
      expect(result.body.final).not.toBe(true);
      const intent = h.events().find((e) => e.type === "step.start")?.data.intent ?? "";
      expect(Array.from(intent).length).toBeLessThanOrEqual(120);
      expect(h.events().some((e) => e.type === "task.result")).toBe(false);
    },
  );

  it("does not ask for file-write approval during a pure wait with stale files", async () => {
    const h = setup({
      autoApprove: false,
      autonomy: { ...CAREFUL_AUTONOMY, browsing: "act", computer: "ask" },
    });
    const result = await h.call("done", { ...waiting, files: ["future-output.txt"] });
    expect(result.body).toMatchObject({ ok: true });
    expect(result.body.final).not.toBe(true);
    expect(h.events().some((e) => e.type === "approval.request")).toBe(false);
    expect(h.outputs.size).toBe(0);
  });

  it("honors the user's action limit instead of waiting indefinitely", async () => {
    const h = setup({ maxToolCalls: 1 });
    const sleep = vi.spyOn(h.tools, "sleep");
    await h.call("done", waiting);
    const waited = sleep.mock.calls.length;
    const result = await h.call("done", waiting);
    expect(result.body).toMatchObject({ ok: false, final: true });
    expect(text(result.body)).toContain("user's limit");
    expect(sleep).toHaveBeenCalledTimes(waited);
    expect(h.events().some((e) => e.type === "task.result")).toBe(false);
  });

  it("respects policy denial without waiting or publishing completion", async () => {
    const h = setup({
      policy: { decide: async () => ({ kind: "deny", reason: "fixture denial" }) },
    });
    const sleep = vi.spyOn(h.tools, "sleep");
    const result = await h.call("done", waiting);
    expect(result.body.ok).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
    expect(h.events().some((e) => e.type === "task.result")).toBe(false);
  });

  it.each(["stop", "takeover", "generation"] as const)(
    "cancels on %s without late success",
    async (kind) => {
      const h = setup();
      const held = heldSleep(h);
      const pending = h.call("done", waiting);
      await vi.waitFor(() => expect(held.sleep).toHaveBeenCalledOnce());
      if (kind === "stop") h.session.stop();
      else if (kind === "takeover") h.session.takeControl();
      else h.session.beginBrain();
      const result = await pending;
      expect(result.body.ok).toBe(false);
      held.release();
      await Promise.resolve();
      expect(h.events().some((e) => e.type === "task.result")).toBe(false);
      expect(h.events().some((e) => e.type === "tool.end" && e.data.ok)).toBe(false);
    },
  );

  it("reaches the Pause boundary after its short wait interval without continuing", async () => {
    const h = setup();
    const held = heldSleep(h);
    const pending = h.call("done", waiting);
    await vi.waitFor(() => expect(held.sleep).toHaveBeenCalledOnce());
    h.session.requestSafetyPause(ulid());
    held.release();
    const result = await pending;
    expect(result.body).toMatchObject({ ok: false, pause: true });
    expect(h.session.status).toBe("paused");
    expect(held.sleep).toHaveBeenCalledOnce();
    expect(h.events().some((e) => e.type === "task.result")).toBe(false);
  });

  it("ends the wait early for a new user instruction", async () => {
    const h = setup();
    const held = heldSleep(h);
    const pending = h.call("done", waiting);
    await vi.waitFor(() => expect(held.sleep).toHaveBeenCalledOnce());
    h.session.post("steer", "Change the task to checking the score.");
    held.release();
    const result = await pending;
    expect(result.body).toMatchObject({ ok: true });
    expect(result.body.final).not.toBe(true);
    expect(text(result.body)).toContain("new user instruction");
    expect(held.sleep).toHaveBeenCalledOnce();
    expect(h.events().some((e) => e.type === "task.result")).toBe(false);
  });

  it("uses the existing input form when the user really must supply something", async () => {
    const h = setup();
    const sleep = vi.spyOn(h.tools, "sleep");
    const pending = h.call("done", {
      ...waiting,
      input_request: { question: "Which room should I join?", allow_text: true },
    });
    await vi.waitFor(() => expect(h.session.pendingAsk).toBeDefined());
    expect(h.session.status).toBe("waiting_user");
    expect(h.session.answer(h.session.pendingAsk as string, undefined, "Room fixture")).toBe(true);
    expect((await pending).body.final).not.toBe(true);
    expect(sleep).not.toHaveBeenCalled();
    expect(h.events().some((e) => e.type === "task.result")).toBe(false);
  });

  it("records genuine blocked work without claiming successful verification", async () => {
    const h = setup();
    const result = await h.call("done", {
      summary: "The match was deleted; it cannot be resumed.",
      completion: { status: "blocked", evidence: "Server says the match no longer exists" },
      checked: "Confirmed server error",
      input_request: null,
    });
    expect(result.body).toMatchObject({ ok: true, final: true });
    expect(text(result.body)).toContain("unfinished work");
    expect(h.events().find((e) => e.type === "task.result")?.data).toMatchObject({
      outcome: "blocked",
    });
    expect(h.events().some((e) => e.type === "step.verify" && e.data.status === "success")).toBe(
      false,
    );
  });
});
