import { DEFAULT_AUTONOMY, ulid } from "@localdot/protocol";
import { expect, it, vi } from "vitest";
import { AgentSession } from "../session.ts";
import { computerTool } from "./computer.ts";
import type { ToolCallContext, ToolDeps } from "./deps.ts";

function setup() {
  const session = new AgentSession(ulid(), ulid(), "test", { append: vi.fn() }, DEFAULT_AUTONOMY);
  session.taskAutonomy.signIn("desktop");
  const asks = vi.spyOn(session, "requestApproval");
  const signal = new AbortController().signal;
  const ctx = {
    session,
    generation: { id: 1, signal },
    signal,
    check() {},
    callId: ulid(),
    step: ulid(),
    redact: (s: string) => s,
  } as unknown as ToolCallContext;
  const windowControl = vi.fn(async (_input: unknown) => ({ windowId: 42 }));
  const observe = vi.fn(async () => {
    throw new Error("after native operation");
  });
  const deps = { launcher: () => ({ windowControl }), gateway: { observe } } as unknown as ToolDeps;
  return { ctx, deps, windowControl, asks };
}

it.each(["maximize_window", "restore_window", "minimize_window"] as const)(
  "%s manages an exact native window without a click approval",
  async (action) => {
    const f = setup();
    await expect(computerTool(f.deps, f.ctx, { action })).rejects.toThrow("after native operation");
    expect(f.windowControl.mock.calls.map(([request]) => request)).toEqual([
      { action: "inspect" },
      { action: "inspect" },
      { action, windowId: 42 },
    ]);
    expect(f.asks).not.toHaveBeenCalled();
  },
);

it("refuses a window that changed during authorization", async () => {
  const f = setup();
  f.windowControl.mockResolvedValueOnce({ windowId: 42 }).mockResolvedValueOnce({ windowId: 99 });
  expect((await computerTool(f.deps, f.ctx, { action: "maximize_window" })).ok).toBe(false);
  expect(f.windowControl).toHaveBeenCalledTimes(2);
});

it("never manages the desktop from the browser screen", async () => {
  const f = setup();
  f.ctx.screen = { selection: { screen: "browser" } } as ToolCallContext["screen"];
  expect((await computerTool(f.deps, f.ctx, { action: "maximize_window" })).ok).toBe(false);
  expect(f.windowControl).not.toHaveBeenCalled();
});
