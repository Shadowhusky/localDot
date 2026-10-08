import { DEFAULT_AUTONOMY, ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { redactor } from "../redact.ts";
import { AgentSession } from "../session.ts";
import { requestTakeoverTool } from "../tools/ask.ts";
import type { ToolCallContext, ToolDeps } from "../tools/deps.ts";
import { authorizePrepared } from "./authorize.ts";
import { decideAutonomy } from "./autonomy.ts";
import { TaskAutonomy } from "./task-autonomy.ts";

function context(screen?: "browser") {
  const session = new AgentSession(ulid(), ulid(), "task", { append: vi.fn() }, DEFAULT_AUTONOMY);
  vi.spyOn(session, "requestApproval").mockResolvedValue("approve");
  const takeover = vi.spyOn(session, "takeover").mockResolvedValue({ by: "stop" });
  const signal = new AbortController().signal;
  const ctx = {
    session,
    generation: { id: 1, signal },
    lease: { generation: { id: 1, signal }, signal, check() {}, finish() {} },
    check() {},
    callId: ulid(),
    step: ulid(),
    redact: redactor([]),
    signal,
    ...(screen ? { screen: { selection: { screen }, finish() {} } } : {}),
  } as unknown as ToolCallContext;
  return { ctx, session, takeover };
}

describe("signed-in screens of one task", () => {
  it("the browser screen is signed in and the desktop is not until the user signs in there", () => {
    const task = new TaskAutonomy();
    expect([task.signedIn("browser"), task.signedIn("desktop")]).toEqual([true, false]);
    task.signIn("browser");
    expect(task.signedIn("desktop")).toBe(false);
    task.signIn("desktop");
    expect(task.signedIn("desktop")).toBe(true);
  });

  it("decisions read the tool's own screen", () => {
    expect(decideAutonomy(context().ctx, { operation: "click" }).mode).toBe("act");
    expect(decideAutonomy(context("browser").ctx, { operation: "click" })).toMatchObject({
      actionClass: "unknown",
      mode: "ask",
    });
  });

  it("a password hand-off on the desktop makes its unclear clicks ask for the rest of the task", async () => {
    const { ctx, session, takeover } = context();
    await authorizePrepared(ctx, {
      tool: "computer",
      input: { action: "type" },
      target: null,
      facts: {
        operation: "type",
        target: { source: "dom", fresh: true, role: "textbox", name: "Password", secret: true },
      },
      revalidate: async () => true,
    });
    expect(takeover).toHaveBeenCalledOnce();
    expect(session.taskAutonomy.signedIn("desktop")).toBe(true);
    expect(decideAutonomy(ctx, { operation: "click" }).mode).toBe("ask");
  });

  it.each([
    ["login", true],
    ["2fa", true],
    ["captcha", true],
    ["payment", true],
    ["other", false],
  ] as const)(
    "asking the user to take over for %s signs the desktop in: %s",
    async (reason, signedIn) => {
      const { ctx, session } = context();
      await requestTakeoverTool({} as ToolDeps, ctx, { reason, note: "Over to you." });
      expect(session.taskAutonomy.signedIn("desktop")).toBe(signedIn);
    },
  );
});
