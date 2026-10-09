import { DEFAULT_AUTONOMY, type RoutineProfile } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { toolHarness } from "../agent/testing/harness.ts";
import {
  askFirst,
  autonomyFor,
  ExpiredRuns,
  readOnlyAllows,
  routinePolicy,
  WRAP_UP,
} from "./policy.ts";

const harnesses: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.close();
});
function routineHarness(profile: RoutineProfile, expired = new ExpiredRuns()) {
  let sessionId = "";
  const h = toolHarness({
    run: { kind: "routine", name: "Morning bills", profile, approvalWindowMinutes: 60 },
    policy: routinePolicy({
      runOf: (id) => (id === sessionId ? h.session.run : undefined),
      expired,
    }),
  });
  sessionId = h.session.id;
  harnesses.push(h);
  return h;
}

describe("routine policy", () => {
  it("read-only refuses shell and typing, and nothing reaches the computer", async () => {
    const h = routineHarness("read_only");
    expect((await h.call("shell", { command: "ls ~/Bills" })).body.ok).toBe(false);
    expect((await h.call("computer", { action: "type", text: "hello" })).body.ok).toBe(false);
    const blocked = h.events().filter((e) => e.type === "step.end" && e.data.status === "blocked");
    expect(blocked).toHaveLength(2);
    expect(h.desktop.shellCalls).toEqual([]);
    expect(h.actions).toEqual([]);
  });

  it("read-only still looks and reads", async () => {
    const h = routineHarness("read_only");
    expect((await h.call("files", { op: "list", path: "Bills" })).body.ok).toBe(true);
    expect((await h.call("browser_read", {})).body.ok).toBe(true);
    expect(
      (await h.call("files", { op: "write", path: "Bills/x.txt", content: "x" })).body.ok,
    ).toBe(false);
    expect((await h.call("ask_user", { question: "Which bank?" })).body.ok).toBe(false);
  });

  it("read-only allows only looking computer actions, batches included", () => {
    const allowed = (input: unknown) => readOnlyAllows({ tool: "computer", input });
    expect(allowed({ action: "screenshot" })).toBe(true);
    expect(allowed({ action: "scroll", dy: 3 })).toBe(true);
    expect(allowed({ action: "click", point: { x: 1, y: 1 } })).toBe(false);
    expect(allowed({ action: "drag" })).toBe(false);
    expect(allowed({ action: "batch", steps: [{ action: "scroll" }, { action: "wait" }] })).toBe(
      true,
    );
    expect(allowed({ action: "batch", steps: [{ action: "scroll" }, { action: "click" }] })).toBe(
      false,
    );
    expect(readOnlyAllows({ tool: "browser_act", input: { action: "click" } })).toBe(false);
    expect(readOnlyAllows({ tool: "request_takeover", input: {} })).toBe(false);
  });

  it("after an approval expires, only update_plan and done are allowed", async () => {
    const expired = new ExpiredRuns();
    const h = routineHarness("ask_first", expired);
    expired.mark(h.session.id);
    const refused = await h.call("shell", { command: "ls" });
    expect(refused.body.ok).toBe(false);
    expect(refused.body.content[0]?.text).toContain(WRAP_UP);
    expect(
      (await h.call("update_plan", { items: [{ text: "Check statements", status: "done" }] })).body
        .ok,
    ).toBe(true);
    expect(
      (await h.call("done", { summary: "Checked two sites; the third needs you." })).body.ok,
    ).toBe(true);
  });

  it("leaves tasks the user started alone", async () => {
    const h = toolHarness({
      policy: routinePolicy({ runOf: () => undefined, expired: new ExpiredRuns() }),
    });
    harnesses.push(h);
    expect((await h.call("files", { op: "write", path: "notes.txt", content: "x" })).body.ok).toBe(
      true,
    );
  });

  it("Ask me first turns consequential Act into Ask and keeps stricter choices", () => {
    const user = {
      ...DEFAULT_AUTONOMY,
      purchase: "act",
      send: "handoff",
      post: "act",
      reading: "act",
      browsing: "ask",
    } as const;
    expect(askFirst(user)).toEqual({ ...user, purchase: "ask", post: "ask" });
    expect(autonomyFor("act_within_rules", user)).toEqual(user);
    expect(autonomyFor("read_only", user)).toEqual(askFirst(user));
    expect(autonomyFor("ask_first", user)).toEqual(askFirst(user));
  });
});
