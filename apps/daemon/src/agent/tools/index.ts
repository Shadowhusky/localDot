import {
  type BrowserNavigateInput,
  type ComputerAction,
  clipText,
  type DoneInput,
  isConnectorToolName,
  isToolName,
  type PeopleInput,
  type RememberInput,
  type RoutineToolInput,
  type ShellInput,
  TOOL_INPUTS,
  type ToolName,
  type ToolResult,
  ulid,
  webUrl,
} from "@localdot/protocol";
import { BrowserClientError } from "../../browser/client.ts";
import { BrowserInUseError, ScreenUnavailableError } from "../../browser/screen-controller.ts";
import type { TaskConnectorTool } from "../../connectors/hub.ts";
import { splitIntent } from "../../connectors/intent.ts";
import type { ToolPolicy } from "../policy.ts";
import type { Redactor } from "../redact.ts";
import { authorizePrepared, freezeExecutionInput, toolRisk } from "../safety/authorize.ts";
import { prepareLocalCleanup } from "../safety/local-cleanup.ts";
import { PausedStepError } from "../safety/step-barrier.ts";
import type { AgentSession, BrainGeneration, ToolLease } from "../session.ts";
import { withRecoveryAdvice } from "../work-progress.ts";
import { askUserTool, requestTakeoverTool } from "./ask.ts";
import { browserNavigateTool, browserReadTool } from "./browser.ts";
import { browserActTool } from "./browser-act.ts";
import { browserUploadTool } from "./browser-upload.ts";
import { computerTool, untilPaused } from "./computer.ts";
import { connectorFacts, connectorTool } from "./connector.ts";
import { apiRequestTool, credentialsTool } from "./credentials.ts";
import { append, fail, intentOf, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
import { doneTool } from "./done.ts";
import { filesTool } from "./files.ts";
import { findTool } from "./find.ts";
import { peopleTool, saveRefusal } from "./people.ts";
import { updatePlanTool } from "./plan.ts";
import { recallTool } from "./recall.ts";
import { rememberTool } from "./remember.ts";
import { researchRefusal, researchTool, withResearchNote } from "./research.ts";
import { followUpAtTool, routineTool } from "./routine.ts";
import { switchScreenTool } from "./screen.ts";
import { shellTool } from "./shell.ts";
import { webFetchTool, webSearchTool } from "./web.ts";
import { opensInWebBrowser } from "./web-page.ts";
import { startWorkClock } from "./work-clock.ts";
import { workContextTool } from "./work-context.ts";

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
  work_context: "think",
  credentials: "ask",
  api_request: "app",
  computer: "gui",
  shell: "shell",
  files: "file",
  browser_read: "browser",
  browser_navigate: "browser",
  browser_upload: "browser",
  browser_act: "gui",
  web_search: "browser",
  web_fetch: "browser",
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
  research: "browser",
};

// What saving to each memory file says in the chat and Activity.
const REMEMBERED: Record<RememberInput["file"], string> = {
  "USER.md": "Remember this about you",
  "MEMORY.md": "Save to memory",
  notes: "Add to today's notes",
};

// A call that records nothing of its own still shows as a step, as every other call does.
async function stepped(
  ctx: ToolCallContext,
  tool: ToolName,
  title: string,
  run: (ctx: ToolCallContext) => ToolResult | Promise<ToolResult>,
): Promise<ToolResult> {
  append(ctx, "step.start", { kind: STEP_KIND[tool] });
  append(ctx, "tool.start", { tool, title: clipText(title, 200) });
  const result = await run(ctx);
  if (ctx.session.stopped) return result;
  append(ctx, "tool.end", { ok: result.ok });
  append(ctx, "step.end", { status: result.ok ? "ok" : "failed" });
  return result;
}

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

// What acts on or reads the screen takes its turn on the computer, which its tasks share.
const ON_SCREEN = new Set<string>([
  "computer",
  "find",
  "browser_read",
  "browser_navigate",
  "browser_act",
  "browser_upload",
  "switch_screen",
]);

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
  if (isConnectorToolName(name) && rawInput && typeof rawInput === "object")
    queuedInput = freezeExecutionInput(rawInput);
  else if (isToolName(name)) {
    const parsed = TOOL_INPUTS[name].safeParse(rawInput);
    if (!parsed.success)
      return {
        status: 400,
        result: {
          ...fail(`Invalid ${name} input: ${redact(clipText(parsed.error.message, 1000))}`),
          recovery: { kind: "invalid_input", surface: "runtime", retry: "after_change" },
        },
      };
    // A completion carrying a missing-input form is an ask, not a final result. Normalize
    // before admission/policy, privacy handling, clocks and step logging so it receives the
    // exact same checks and waiting semantics as a direct ask_user call. Do not collect its
    // proposed output files or save its proposed experience while work is still incomplete.
    const request = name === "done" ? (parsed.data as DoneInput).input_request : undefined;
    if (request) {
      name = "ask_user";
      queuedInput = freezeExecutionInput(request);
    } else queuedInput = freezeExecutionInput(parsed.data);
  }
  const clock = startWorkClock(session, name, queuedInput);
  const signal = clock
    ? AbortSignal.any([clock.signal, ...(requestSignal ? [requestSignal] : [])])
    : requestSignal;
  try {
    // Takeover is a control interrupt. It must be able to cancel an approval or
    // policy wait and drain it through the existing ToolLease owner, so it skips the
    // step queue; the session still refuses it while a Pause is held.
    const invoke = async () => {
      session.workProgress.reset(`${generation.id}:${session.requests.length}`);
      const outcome = await dispatchAdmitted(
        deps,
        session,
        name,
        callId,
        queuedInput,
        redact,
        generation,
        signal,
      );
      if (
        session.stopped ||
        !session.isCurrent(generation) ||
        signal?.aborted ||
        (!isToolName(name) && !session.connectors.get(name))
      )
        return outcome;
      return {
        ...outcome,
        result: withRecoveryAdvice(session.workProgress.record(name, queuedInput, outcome.result)),
      };
    };
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
    // A look at the screen, as a brain's first one is, changes nothing: it answers nothing either.
    lease =
      name === "computer" && (rawInput as Partial<ComputerAction>).action === "screenshot"
        ? session.admit(generation, requestSignal)
        : session.admitCall(generation, requestSignal);
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
      const entry = isConnectorToolName(name) ? session.connectors.get(name) : undefined;
      if (entry) return await dispatchConnector(deps, ctx, entry, rawInput, redact);
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
      return {
        status: 200,
        result: {
          ...fail(`Refused by localDot's rules: ${note}`),
          recovery: { kind: "permission", surface: "runtime", retry: "never" },
        },
      };
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
    const stopped = researchRefusal(session, name, frozen);
    if (stopped) return { status: 200, result: fail(stopped) };
    if (ON_SCREEN.has(name) && deps.tools.computer) {
      const waiting = untilPaused(session, ctx.signal);
      try {
        ctx.turn = await deps.tools.computer.take(session.id, session.cellId, waiting.signal);
      } catch (error) {
        if (session.safetyPause && !session.stopped) throw new PausedStepError();
        throw error;
      } finally {
        waiting.end();
      }
      ctx.check();
    }
    if (
      [
        "computer",
        "find",
        "browser_read",
        "browser_navigate",
        "browser_act",
        "browser_upload",
        "switch_screen",
        "ask_user",
        "request_takeover",
      ].includes(name)
    ) {
      await deps.tools.hideWork?.(session.id);
      ctx.check();
    }
    // Public pages open in the web browser, where the user's sign-ins are; local addresses
    // only resolve on the desktop.
    const page = name === "browser_navigate" && webUrl((frozen as BrowserNavigateInput).url);
    const shown = session.screens?.selection.screen;
    let shared = false;
    if (page && opensInWebBrowser(page) && shown === "desktop") {
      try {
        await session.switchScreen("browser", lease);
      } catch (error) {
        ctx.check();
        // Another task has the web browser: the page opens in the desktop's Chromium.
        if (error instanceof BrowserInUseError) shared = true;
        else if (!(error instanceof ScreenUnavailableError)) throw error;
        else
          return {
            status: 200,
            result: {
              recovery: { kind: "unavailable", surface: "browser", retry: "after_change" },
              ...fail(
                error.status
                  ? `${error.message} Then open the page again with browser_navigate; don't ask for credentials again.`
                  : `The browser is temporarily unavailable${error.problem ? ` (${error.problem.replace(/\.$/u, "")})` : ""}. Saved sign-ins are still kept. Retry browser_navigate once it is ready; do not open a second browser or ask for credentials again.`,
              ),
            },
          };
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
      if (
        name === "browser_read" ||
        (name === "computer" && (frozen as ComputerAction).action === "screenshot")
      )
        await session.screens.refreshBrowser(screen);
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
      // Only unchanged files observed being created by this task qualify. The
      // execution path retains their bytes; custom deletion policies still win.
      if (name === "shell" && session.permissionMode() !== "custom") {
        ctx.localCleanup = await prepareLocalCleanup(deps.tools, ctx, frozen as ShellInput);
        ctx.check();
        if (ctx.localCleanup) facts.command = ctx.localCleanup.riskCommand;
      }
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
          result: {
            ...fail("This action was not authorized. Do not retry it automatically."),
            recovery: { kind: "permission", surface: "runtime", retry: "never" },
          },
        };
    }
    const t = deps.tools,
      input = frozen as never;
    switch (name) {
      case "work_context":
        result = await workContextTool(t, ctx, input);
        break;
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
      case "web_search":
        result = await webSearchTool(t, ctx, input);
        break;
      case "web_fetch":
        result = await webFetchTool(t, ctx, input);
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
      case "credentials":
        result = await credentialsTool(t, ctx, input);
        break;
      case "api_request":
        result = await apiRequestTool(t, ctx, input);
        break;
      case "ask_user":
        result = await askUserTool(t, ctx, input);
        break;
      case "request_takeover":
        result = await requestTakeoverTool(t, ctx, input);
        break;
      case "remember":
        result = await stepped(ctx, name, REMEMBERED[(frozen as RememberInput).file], (c) =>
          rememberTool(t, c, input),
        );
        break;
      case "recall":
        result = await recallTool(t, ctx, input);
        break;
      case "people":
        result = await peopleTool(t, ctx, input);
        break;
      case "done": {
        // A lesson is memory too: like remember's facts, none is kept from untrusted content.
        const dropped = session.tainted && !!(frozen as DoneInput).experience;
        result = await doneTool(dropped ? { ...t, saveExperience: undefined } : t, ctx, input);
        if (dropped && result.final)
          result = {
            ...result,
            content: [
              ...result.content,
              text(
                "The lesson was not saved: this task read content from outside the user's own words.",
              ),
            ],
          };
        break;
      }
      case "routine": {
        const routine = frozen as RoutineToolInput;
        const title =
          routine.op === "list"
            ? "Check the routines"
            : routine.op === "pause"
              ? "Pause a routine"
              : `Propose a routine: ${redact(routine.name ?? "")}`;
        result = await stepped(ctx, name, title, (c) => routineTool(t, c, input));
        break;
      }
      case "follow_up_at":
        result = await stepped(ctx, name, "Schedule a follow-up", (c) =>
          followUpAtTool(t, c, input),
        );
        break;
      case "research":
        result = await researchTool(t, ctx, input);
        break;
    }
    result = withResearchNote(session, name, frozen, result);
    if (shared)
      result = {
        ...result,
        content: [
          text(
            "Another task is using the web browser, so this opened in the desktop's Chromium, which keeps no sign-ins.",
          ),
          ...result.content,
        ],
      };
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
          c.type === "text"
            ? { ...c, text: redact(c.text) }
            : c.type === "web_image"
              ? { ...c, url: redact(c.url) }
              : c,
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
        ...(error instanceof ScreenUnavailableError ||
        (error instanceof BrowserClientError &&
          (error.code === "restarting" || error.code === "unavailable"))
          ? {
              recovery: {
                kind: "unavailable" as const,
                surface: "browser" as const,
                retry: "after_change" as const,
              },
            }
          : {}),
        ...(result?.cancelled === "stale" ? { cancelled: "stale" as const } : {}),
        ...(session.stopped ? { final: true } : {}),
      },
    };
  } finally {
    ctx?.screen?.finish();
    await ctx?.turn?.release().catch(() => {});
    lease?.finish();
  }
}

// A connected app's tool: still on, arguments as its schema says, within the user's limit and the
// policy, then the same checks as any step: read-only tools run, changes ask with the exact
// arguments, and what goes out passes the purpose check.
async function dispatchConnector(
  deps: DispatchDeps,
  ctx: ToolCallContext,
  entry: TaskConnectorTool,
  rawInput: unknown,
  redact: Redactor,
): Promise<DispatchOutcome> {
  const { session } = ctx;
  const refuse = (title: string, note: string): DispatchOutcome => {
    blocked(session, entry.exposed, "app", title, note);
    return {
      status: 200,
      result: {
        ...fail(note),
        recovery: { kind: "permission", surface: "connector", retry: "never" },
      },
    };
  };
  const hub = deps.tools.connectors;
  const access = hub?.access(entry);
  if (!hub || !access)
    return refuse(
      `${entry.app} is off`,
      `${entry.app} or this tool is turned off. Respect the user’s access settings; do not retry it automatically.`,
    );
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput))
    return {
      status: 400,
      result: {
        ...fail(`Invalid ${entry.exposed} input: an object is needed.`),
        recovery: { kind: "invalid_input", surface: "connector", retry: "after_change" },
      },
    };
  const { intent, args } = splitIntent(entry, rawInput as Record<string, unknown>);
  const problem = hub.check(entry, args);
  if (problem)
    return {
      status: 400,
      result: {
        ...fail(`Invalid ${entry.exposed} input: ${redact(clipText(problem, 1000))}`),
        recovery: { kind: "invalid_input", surface: "connector", retry: "after_change" },
      },
    };
  session.toolCalls += 1;
  session.actionsSinceUser += 1;
  const limit = session.actionLimit ?? deps.maxToolCalls;
  if (limit !== undefined && session.actionsSinceUser > limit) {
    session.actionLimitReached = true;
    blocked(session, entry.exposed, "app", "Action limit", `reached your limit of ${limit}`);
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
  const frozen = freezeExecutionInput(args);
  const decision = await deps.policy?.decide({
    sessionId: session.id,
    tool: entry.exposed,
    input: frozen,
    tainted: session.tainted,
  });
  ctx.check();
  if (decision && decision.kind !== "act") {
    const note = redact(
      decision.kind === "ask" ? `needs approval: ${decision.reason}` : decision.reason,
    );
    blocked(session, entry.exposed, "app", `Refused ${entry.app}`, note);
    return {
      status: 200,
      result: {
        ...fail(`Refused by localDot's rules: ${note}`),
        recovery: { kind: "permission", surface: "runtime", retry: "never" },
      },
    };
  }
  ctx.permit = await authorizePrepared(ctx, {
    tool: entry.exposed,
    input: frozen,
    target: null,
    facts: connectorFacts(
      entry,
      access.actionClass,
      access.from === "you" && access.access === "write",
    ),
    revalidate: async () => {
      ctx.check();
      return hub.access(entry) !== undefined;
    },
  });
  ctx.check();
  if (!ctx.permit)
    return {
      status: 200,
      result: {
        ...fail("This action was not authorized. Do not retry it automatically."),
        recovery: { kind: "permission", surface: "runtime", retry: "never" },
      },
    };
  const result = await connectorTool(deps.tools, ctx, entry, frozen, intent);
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
      content: result.content.map((c) => (c.type === "text" ? { ...c, text: redact(c.text) } : c)),
    },
  };
}
