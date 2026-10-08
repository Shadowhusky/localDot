import { type AutonomyPolicy, DEFAULT_AUTONOMY, type ScreenName, ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { redactor } from "../redact.ts";
import { AgentSession } from "../session.ts";
import { requestTakeoverTool } from "../tools/ask.ts";
import type { ToolCallContext, ToolDeps } from "../tools/deps.ts";
import { authorizePrepared, toolRisk } from "./authorize.ts";
import { decideAutonomy } from "./autonomy.ts";
import { PausedStepError } from "./step-barrier.ts";
import { TaskAutonomy } from "./task-autonomy.ts";

function context(
  screen?: ScreenName,
  selected?: ScreenName,
  policy: AutonomyPolicy = DEFAULT_AUTONOMY,
) {
  const session = new AgentSession(ulid(), ulid(), "task", { append: vi.fn() }, policy);
  if (selected)
    vi.spyOn(session, "screens", "get").mockReturnValue({
      selection: { screen: selected },
    } as never);
  const asks = vi.spyOn(session, "requestApproval").mockResolvedValue("approve");
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
  return { ctx, session, takeover, asks };
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

  it("the tool's own screen wins over the selected one, which applies when the tool has none", () => {
    expect(decideAutonomy(context("browser", "desktop").ctx, { operation: "click" }).mode).toBe(
      "ask",
    );
    expect(decideAutonomy(context("desktop", "browser").ctx, { operation: "click" }).mode).toBe(
      "act",
    );
    expect(decideAutonomy(context(undefined, "browser").ctx, { operation: "click" }).mode).toBe(
      "ask",
    );
  });

  it("commands and file changes run on the desktop, so only its sign-in makes them ask", async () => {
    const { ctx, session, asks } = context(undefined, "browser");
    const command = { operation: "shell", command: "xdotool key Return" } as const;
    expect(decideAutonomy(ctx, command).mode).toBe("act");
    expect(decideAutonomy(ctx, { operation: "files_write" }).mode).toBe("act");
    session.taskAutonomy.signIn("desktop");
    expect(decideAutonomy(ctx, command)).toEqual({
      actionClass: "unknown",
      mode: "ask",
      risk: "medium",
    });
    expect(decideAutonomy(ctx, { operation: "files_write" }).mode).toBe("ask");
    const input = { command: "xdotool key Return" };
    const facts = toolRisk("shell", input);
    if (!facts) throw new Error("shell has no facts");
    await authorizePrepared(ctx, {
      tool: "shell",
      input,
      target: null,
      facts,
      revalidate: async () => true,
    });
    expect(asks).toHaveBeenCalledOnce();
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

  it("a held Pause refuses a password hand-off or a login takeover before signing anything in", async () => {
    const { ctx, session, takeover } = context();
    session.requestSafetyPause(ulid());
    await expect(
      authorizePrepared(ctx, {
        tool: "computer",
        input: { action: "type" },
        target: null,
        facts: {
          operation: "type",
          target: { source: "dom", fresh: true, role: "textbox", name: "Password", secret: true },
        },
        revalidate: async () => true,
      }),
    ).rejects.toBeInstanceOf(PausedStepError);
    await expect(
      requestTakeoverTool({} as ToolDeps, ctx, { reason: "login", note: "Over to you." }),
    ).rejects.toBeInstanceOf(PausedStepError);
    expect(takeover).not.toHaveBeenCalled();
    expect(session.taskAutonomy.signedIn("desktop")).toBe(false);
  });

  it("a hand-off the user chose, or one for a private key, leaves the desktop signed out", async () => {
    const SECRET = "synthetic-known-secret-0123";
    const typeNotes = (ctx: ToolCallContext, text: string) =>
      authorizePrepared(ctx, {
        tool: "computer",
        input: { action: "type", text },
        target: null,
        facts: {
          operation: "type",
          target: { source: "ax", fresh: true, role: "AXTextArea", name: "Notes", app: "Editor" },
        },
        revalidate: async () => true,
      });
    const chosen = context(undefined, undefined, { ...DEFAULT_AUTONOMY, computer: "handoff" });
    await typeNotes(chosen.ctx, "draft");
    const keyed = context();
    await typeNotes({ ...keyed.ctx, redact: redactor([SECRET]) }, `token ${SECRET}`);
    for (const { takeover, session } of [chosen, keyed]) {
      expect(takeover.mock.calls[0]?.[0]).toBe("other");
      expect(session.taskAutonomy.signedIn("desktop")).toBe(false);
    }
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

  it("a login takeover signs the desktop in even while the browser screen is selected", async () => {
    const { ctx, session } = context(undefined, "browser");
    await requestTakeoverTool({} as ToolDeps, ctx, { reason: "login", note: "Over to you." });
    expect(session.taskAutonomy.signedIn("desktop")).toBe(true);
  });
});
