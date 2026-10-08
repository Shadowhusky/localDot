import {
  type AutonomyPolicy,
  BALANCED_AUTONOMY,
  CAREFUL_AUTONOMY,
  type LocalDotEvent,
  ulid,
} from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuiAction, NativeActionIdentity } from "../gateway/gateway.ts";
import { redactor } from "./redact.ts";
import { type EvidenceRow, MANUAL_DRAWING_TASK } from "./safety/fixtures/manual-drawing-task.ts";
import { toolHarness } from "./testing/harness.ts";
import { dispatchTool } from "./tools/index.ts";

type Harness = ReturnType<typeof toolHarness>;
type Call = { id: string; tool: string; input: unknown };

const owned: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const close of owned.splice(0)) close();
});

// The drawing task's calls in order. Rows 30–32 are one key call with repeat 5; H4 is the model's
// own request for help, not a policy decision.
const CALLS: Call[] = MANUAL_DRAWING_TASK.flatMap((row: EvidenceRow): Call[] => {
  if (row.kind === "model" || row.id === "31" || row.id === "32") return [];
  if (row.kind === "tool") return [{ id: row.id, tool: row.tool, input: row.input }];
  const action = row.id === "30" ? { ...row.action, repeat: 5 } : row.action;
  return [{ id: row.id, tool: "computer", input: action }];
});
const PRESSES = CALLS.filter((c) => c.tool === "computer").length + 4;
const COMMANDS = CALLS.filter((c) => c.tool === "shell").map(
  (c) => (c.input as { command: string }).command,
);

// The paint app had no accessibility tree, so every hit-test and focus read is a bare point.
// The fake keeps the real gateway's order: authorize, read the target again and consume the
// permit, admit the effect past the repeat guard, then dispatch.
function paintApp(h: Harness) {
  const dispatched: GuiAction[] = [];
  const identity = (action: GuiAction): NativeActionIdentity => ({
    target: null,
    window: 7,
    point: ("point" in action && action.point) || null,
  });
  h.tools.gateway = {
    ...h.tools.gateway,
    run: async (ctx, action) => {
      const seen = identity(action);
      const permit = await ctx.authorizeAgent?.({
        action,
        identity: seen,
        revalidate: async () => true,
      });
      if (!permit) return { ok: false, cancelled: "user", error: "not authorized" };
      const fresh = identity(action);
      if (!permit.consume(action, fresh, fresh))
        return { ok: false, cancelled: "stale", error: "changed" };
      if (ctx.beforeEffect?.(action, seen) !== true)
        return { ok: false, cancelled: "user", error: "paused" };
      dispatched.push(action);
      return { ok: true, frameId: ulid() };
    },
  };
  return dispatched;
}

function harness(autonomy: AutonomyPolicy, autoApprove = true) {
  const h = toolHarness({ autonomy, autoApprove });
  owned.push(h.close);
  const events: LocalDotEvent[] = [];
  h.eventLog.subscribe((id, event) => {
    if (id !== h.session.id) return;
    events.push(event);
    // A hand-off would wait for the user forever; give control straight back so the replay ends.
    if (event.type === "takeover.request")
      queueMicrotask(() => h.session.endTakeover(event.data.requestId, undefined));
  });
  return { h, events, dispatched: paintApp(h) };
}

function dispatch(h: Harness, call: Call) {
  return dispatchTool(
    { tools: h.tools },
    h.session,
    call.tool,
    ulid(),
    call.input,
    redactor([]),
    h.session.generation,
  );
}

async function replay(autonomy: AutonomyPolicy) {
  const f = harness(autonomy);
  const rows = [];
  for (const call of CALLS) {
    const from = f.events.length;
    const out = await dispatch(f.h, call);
    const seen = f.events.slice(from);
    rows.push({
      id: call.id,
      ok: out.result.ok,
      cards: seen.flatMap((e) => (e.type === "approval.request" ? [e.data] : [])),
      handoffs: seen.filter((e) => e.type === "takeover.request").length,
      repeatPauses: seen.filter(
        (e) => e.type === "safety.pause" && e.data.pause?.reason === "repeated_action",
      ).length,
    });
  }
  return { ...f, rows };
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

describe("the manual drawing task replayed through the tool dispatcher", () => {
  it("replays every recorded call once, with the key presses as one repeat-5 call", () => {
    expect(CALLS).toHaveLength(34);
    expect(CALLS.find((c) => c.id === "30")?.input).toEqual({
      action: "key",
      keys: ["bracketright"],
      repeat: 5,
    });
  });

  it("Balanced runs every call without a card, a hand-off or a repeat pause", async () => {
    const { h, rows, dispatched } = await replay(BALANCED_AUTONOMY);
    expect(ids(rows.filter((row) => row.cards.length > 0))).toEqual([]);
    expect(ids(rows.filter((row) => row.handoffs > 0))).toEqual([]);
    expect(ids(rows.filter((row) => row.repeatPauses > 0))).toEqual([]);
    expect(ids(rows.filter((row) => !row.ok))).toEqual([]);
    expect(h.session.safetyPause).toBeUndefined();
    expect(h.desktop.shellCalls).toEqual(COMMANDS);
    expect(h.desktop.files.has("sketch.py")).toBe(true);
    expect(h.desktop.editCalls).toEqual(["sketch.py", "sketch.py"]);
    expect(dispatched).toHaveLength(PRESSES);
  });

  it("Careful shows one card per call and never hands off", async () => {
    const { h, rows, dispatched } = await replay(CAREFUL_AUTONOMY);
    expect(ids(rows.filter((row) => row.cards.length !== 1))).toEqual([]);
    expect(rows.flatMap((row) => row.cards.map((card) => card.actionClass))).toEqual(
      CALLS.map(() => "computer"),
    );
    expect(ids(rows.filter((row) => row.handoffs > 0))).toEqual([]);
    expect(ids(rows.filter((row) => row.repeatPauses > 0))).toEqual([]);
    expect(ids(rows.filter((row) => !row.ok))).toEqual([]);
    const repeated = rows.find((row) => row.id === "30")?.cards[0];
    expect(repeated?.preview.fields).toContainEqual(["Repeat", "× 5"]);
    expect(h.desktop.shellCalls).toEqual(COMMANDS);
    expect(h.desktop.editCalls).toEqual(["sketch.py", "sketch.py"]);
    expect(dispatched).toHaveLength(PRESSES);
  });

  it("Careful keeps a card open for ten minutes and runs the click when it is approved", async () => {
    vi.useFakeTimers();
    const { h, events, dispatched } = harness(CAREFUL_AUTONOMY, false);
    const click = CALLS.find((c) => c.id === "18");
    if (!click) throw new Error("row 18 missing");
    let done = false;
    const out = dispatch(h, click).finally(() => {
      done = true;
    });
    for (let i = 0; i < 200 && !h.session.pendingApproval; i++)
      await vi.advanceTimersByTimeAsync(0);
    const card = h.session.pendingApproval;
    if (!card) throw new Error("no card");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(done).toBe(false);
    expect(h.session.pendingApproval?.approvalId).toBe(card.approvalId);
    expect(events.filter((e) => e.type === "approval.resolve")).toEqual([]);
    expect(
      h.session.answerApproval({
        approvalId: card.approvalId,
        generation: card.generation,
        revision: card.revision,
        decision: "approve",
      }),
    ).toBe(true);
    expect((await out).result.ok).toBe(true);
    expect(dispatched).toEqual([expect.objectContaining({ verb: "click", count: 3 })]);
  });
});
