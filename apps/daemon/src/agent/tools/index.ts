import {
  type BrowserNavigateInput,
  clipText,
  isToolName,
  type PeopleInput,
  TOOL_INPUTS,
  type ToolName,
  type ToolResult,
  ulid,
  webUrl,
} from "@localdot/protocol";
import { ScreenUnavailableError } from "../../browser/screen-controller.ts";
import type { ToolPolicy } from "../policy.ts";
import type { Redactor } from "../redact.ts";
import { authorizePrepared, freezeExecutionInput, toolRisk } from "../safety/authorize.ts";
import { PausedStepError } from "../safety/step-barrier.ts";
import type { AgentSession, BrainGeneration, ToolLease } from "../session.ts";
import { askUserTool, requestTakeoverTool } from "./ask.ts";
import {
  browserNavigateTool,
  browserReadTool,
  DESKTOP_FALLBACK,
  opensInWebBrowser,
} from "./browser.ts";
import { browserActTool } from "./browser-act.ts";
import { browserUploadTool } from "./browser-upload.ts";
import { computerTool } from "./computer.ts";
import { append, fail, intentOf, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
import { doneTool } from "./done.ts";
import { filesTool } from "./files.ts";
import { findTool } from "./find.ts";
import { peopleTool, saveRefusal } from "./people.ts";
import { updatePlanTool } from "./plan.ts";
import { recallTool } from "./recall.ts";
import { rememberTool } from "./remember.ts";
import { followUpAtTool, routineTool } from "./routine.ts";
import { switchScreenTool } from "./screen.ts";
import { shellTool } from "./shell.ts";
import { startWorkClock } from "./work-clock.ts";

export interface DispatchDeps {
  tools: ToolDeps;
  policy?: ToolPolicy; // An extra restriction can refuse; it cannot grant execution authority.
  // A task's own action limit, set by the user, wins over this one.
  maxToolCalls?: number;
}

export type DispatchOutcome = { status: 200 | 400 | 404; result: ToolResult };
const outOfTime = (): DispatchOutcome => ({
  status: 200,
  result: fail("The tool was cancelled or could not complete."),
});

const STEP_KIND: Record<ToolName, string> = {
  computer: "gui",
  shell: "shell",
  files: "file",
  browser_read: "browser",
  browser_navigate: "browser",
  browser_upload: "browser",
  browser_act: "gui",
  find: "gui",
  switch_screen: "browser",
  update_plan: "think",
  ask_user: "ask",
  request_takeover: "ask",
  remember: "think",
  recall: "think",
  people: "think",
  done: "think",
  routine: "think",
  follow_up_at: "think",
};

function blocked(
  session: AgentSession,
  tool: string,
  kind: string,
  title: string,
  note: string,
): void {
  const step = ulid();
  session.append("step.start", { kind }, step);
  session.append("tool.start", { tool: clipText(tool, 64), title: clipText(title, 200) }, step);
  session.append("tool.end", { ok: false }, step);
  session.append("step.end", { status: "blocked", note: clipText(note, 500) }, step);
}

// One tool call from the brain: the v1 table, the input's schema, the user's action limit and the
// policy seam come first, in that order; only then does anything reach the computer or the user.
// The limit is enforced here, outside the brain's cell (trust rule 5), and only when the user set
// one; their next message starts its count again.
export async function dispatchTool(
  deps: DispatchDeps,
  session: AgentSession,
  name: string,
  callId: string,
  rawInput: unknown,
  redact: Redactor,
  generation: BrainGeneration | undefined = session.generation,
  requestSignal?: AbortSignal,
): Promise<DispatchOutcome> {
  if (!generation) return { status: 200, result: fail("No active brain generation.") };
  let queuedInput = rawInput;
  if (isToolName(name)) {
    const parsed = TOOL_INPUTS[name].safeParse(rawInput);
    if (!parsed.success)
      return {
        status: 400,
        result: fail(`Invalid ${name} input: ${redact(clipText(parsed.error.message, 1000))}`),
      };
    queuedInput = freezeExecutionInput(parsed.data);
  }
  const clock = startWorkClock(session, name, queuedInput);
  const signal = clock
    ? AbortSignal.any([clock.signal, ...(requestSignal ? [requestSignal] : [])])
    : requestSignal;
  try {
    // Takeover is a control interrupt. It must be able to cancel an approval or
    // policy wait and drain it through the existing ToolLease owner, so it skips the
    // step queue; the session still refuses it while a Pause is held.
    const invoke = () =>
      dispatchAdmitted(deps, session, name, callId, queuedInput, redact, generation, signal);
    const outcome =
      name === "request_takeover"
        ? await invoke()
        : await session.runAtomic(generation, signal, invoke);
    if (clock?.expired && !outcome.result.ok && !session.stopped) return outOfTime();
    return session.safetyPause && !outcome.result.final
      ? { ...outcome, result: { ...outcome.result, pause: true } }
      : outcome;
  } catch (error) {
    if (clock?.expired && !session.stopped) return outOfTime();
    if (error instanceof PausedStepError && !session.stopped)
      return {
        status: 200,
        result: {
          ok: false,
          pause: true,
          content: [
            {
              type: "text",
              text: "The task is paused. Wait for an explicit Resume; do not retry.",
            },
          ],
        },
      };
    return {
      status: 200,
      result: {
        ...fail(redact(error instanceof Error ? error.message : String(error))),
        ...(session.stopped ? { final: true } : {}),
      },
    };
  } finally {
    clock?.stop();
  }
}
async function dispatchAdmitted(
  deps: DispatchDeps,
  session: AgentSession,
  name: string,
  callId: string,
  rawInput: unknown,
  redact: Redactor,
  generation: BrainGeneration,
  requestSignal?: AbortSignal,
): Promise<DispatchOutcome> {
  let lease: ToolLease | undefined;
  let ctx: ToolCallContext | undefined;
  let result: ToolResult | undefined;
  try {
    if (!generation) throw new Error("No active brain generation");
    lease = session.admit(generation, requestSignal);
    const activeLease = lease;
    const step = ulid();
    ctx = {
      session,
      generation,
      lease,
      check: () => activeLease.check(),
      callId,
      step,
      redact,
      signal: lease.signal,
    };
    ctx.check();
    if (!isToolName(name)) {
      blocked(session, redact(name), "think", "Unknown tool", "not a v1 tool");
      return { status: 404, result: fail(`There is no tool named ${redact(clipText(name, 64))}.`) };
    }
    const parsed = TOOL_INPUTS[name].safeParse(rawInput);
    if (!parsed.success)
      return {
        status: 400,
        result: fail(`Invalid ${name} input: ${redact(clipText(parsed.error.message, 1000))}`),
      };
    // A batch's every step is an action.
    const steps =
      name === "computer" ? ((parsed.data as { steps?: unknown[] }).steps?.length ?? 1) : 1;
    session.toolCalls += 1;
    session.actionsSinceUser += steps;
    const limit = session.actionLimit ?? deps.maxToolCalls;
    if (limit !== undefined && session.actionsSinceUser > limit) {
      session.actionLimitReached = true;
      blocked(session, name, STEP_KIND[name], "Action limit", `reached your limit of ${limit}`);
      return {
        status: 200,
        result: {
          ok: false,
          final: true,
          content: [
            {
              type: "text",
              text: `This task reached the user's limit of ${limit} actions. Stop; the user will tell you when to continue.`,
            },
          ],
        },
      };
    }
    const frozen = freezeExecutionInput(parsed.data);
    const decision = await deps.policy?.decide({
      sessionId: session.id,
      tool: name,
      input: frozen,
      tainted: session.tainted,
    });
    ctx.check();
    if (decision && decision.kind !== "act") {
      const note = redact(
        decision.kind === "ask" ? `needs approval: ${decision.reason}` : decision.reason,
      );
      blocked(session, name, STEP_KIND[name], `Refused ${name}`, note);
      return { status: 200, result: fail(`Refused by localDot's rules: ${note}`) };
    }
    if (name === "remember" && session.tainted)
      return {
        status: 200,
        result: fail(
          "Memory can only be saved from the user’s own request or reply. Ask the user to confirm the fact first.",
        ),
      };
    const refusal =
      name === "people"
        ? saveRefusal(session, frozen as PeopleInput, deps.tools.people)
        : undefined;
    if (refusal) return { status: 200, result: fail(refusal) };
    // Public pages open in the web browser, where the user's sign-ins are; local addresses
    // only resolve on the desktop.
    let fellBack = false;
    const page = name === "browser_navigate" && webUrl((frozen as BrowserNavigateInput).url);
    const shown = session.screens?.selection.screen;
    if (page && opensInWebBrowser(page) && shown === "desktop") {
      try {
        await session.switchScreen("browser", lease);
      } catch (error) {
        ctx.check();
        if (!(error instanceof ScreenUnavailableError)) throw error;
        fellBack = true;
      }
      ctx.check();
    } else if (page && !opensInWebBrowser(page) && shown === "browser") {
      await session.switchScreen("desktop", lease);
      ctx.check();
    }
    if (
      [
        "computer",
        "browser_read",
        "browser_navigate",
        "browser_upload",
        "browser_act",
        "find",
      ].includes(name) &&
      session.screens
    ) {
      const screen = session.screenLease(lease);
      ctx.screen = screen;
      ctx.signal = AbortSignal.any([lease.signal, screen.signal]);
      ctx.check = () => {
        activeLease.check();
        screen.check();
      };
      if (!deps.tools.bindScreen) throw new Error("The selected screen is unavailable.");
      ctx.nativeScreen = deps.tools.bindScreen(session, screen);
      if (
        ctx.nativeScreen.cellId !== screen.selection.cellId ||
        ctx.nativeScreen.parentCellId !== session.cellId ||
        ctx.nativeScreen.scale !== screen.selection.geometry.scale
      )
        throw new Error("The selected screen does not match this tool call.");
      ctx.check();
    }
    const facts = toolRisk(name, frozen, (id) => deps.tools.routines?.name(id));
    if (facts) {
      ctx.permit = await authorizePrepared(ctx, {
        tool: name,
        input: frozen,
        target: null,
        facts,
        revalidate: async () => {
          ctx?.check();
          return true;
        },
      });
      ctx.check();
      if (!ctx.permit)
        return {
          status: 200,
          result: fail("This action was not authorized. Do not retry it automatically."),
        };
    }
    const t = deps.tools,
      input = frozen as never;
    switch (name) {
      case "computer":
        append(ctx, "step.start", { kind: "gui", ...intentOf(ctx, input) });
        result = await computerTool(t, ctx, input);
        ctx.check();
        // A step refused for a stale look did nothing: dot looks again, nothing failed.
        append(ctx, "step.end", {
          status: result.ok
            ? "ok"
            : result.cancelled === "stale" || ctx.stepCancelled
              ? "cancelled"
              : "failed",
        });
        break;
      case "shell":
        result = await shellTool(t, ctx, input);
        break;
      case "files":
        result = await filesTool(t, ctx, input);
        break;
      case "browser_read":
        result = await browserReadTool(t, ctx, input);
        break;
      case "browser_navigate":
        result = await browserNavigateTool(t, ctx, input);
        if (fellBack) result = { ...result, content: [text(DESKTOP_FALLBACK), ...result.content] };
        break;
      case "browser_upload":
        result = await browserUploadTool(t, ctx, input);
        break;
      case "browser_act":
        append(ctx, "step.start", { kind: "gui", ...intentOf(ctx, input) });
        result = await browserActTool(t, ctx, input);
        ctx.check();
        append(ctx, "step.end", { status: result.ok ? "ok" : "failed" });
        break;
      case "find":
        result = await findTool(t, ctx, input);
        break;
      case "switch_screen":
        result = await switchScreenTool(ctx, input);
        break;
      case "update_plan":
        result = updatePlanTool(ctx, input);
        break;
      case "ask_user":
        result = await askUserTool(t, ctx, input);
        break;
      case "request_takeover":
        result = await requestTakeoverTool(t, ctx, input);
        break;
      case "remember":
        result = await rememberTool(t, ctx, input);
        break;
      case "recall":
        result = await recallTool(t, ctx, input);
        break;
      case "people":
        result = await peopleTool(t, ctx, input);
        break;
      case "done":
        result = await doneTool(t, ctx, input);
        break;
      case "routine":
        result = await routineTool(t, ctx, input);
        break;
      case "follow_up_at":
        result = await followUpAtTool(t, ctx, input);
        break;
    }
    // Containment intentionally stopped the session; its terminal refusal has no image/event.
    if (session.stopped)
      return {
        status: 200,
        result: {
          ok: false,
          final: true,
          content: [{ type: "text", text: "The task has stopped. Do not retry the operation." }],
        },
      };
    ctx.check();
    return {
      status: 200,
      result: {
        ...result,
        content: result.content.map((c) =>
          c.type === "text" ? { ...c, text: redact(c.text) } : c,
        ),
      },
    };
  } catch (error) {
    // A Pause refused this call before its step began, so there is nothing to record.
    if (error instanceof PausedStepError && !session.stopped) throw error;
    const message = redact(error instanceof Error ? error.message : String(error));
    // Cancellation must not emit late success, status changes, or screenshots.
    if (ctx && session.isCurrent(ctx.generation) && !ctx.signal.aborted && !session.controlHeld) {
      try {
        append(ctx, "tool.end", { ok: false });
        append(ctx, "step.end", { status: "failed", note: clipText(message, 500) });
      } catch {
        /* Logging cannot turn a failed tool into an unreadable transport error. */
      }
    }
    return {
      status: 200,
      result: {
        ...fail(message),
        ...(result?.cancelled === "stale" ? { cancelled: "stale" as const } : {}),
        ...(session.stopped ? { final: true } : {}),
      },
    };
  } finally {
    ctx?.screen?.finish();
    lease?.finish();
  }
}
