import {
  clipText,
  isToolName,
  TOOL_INPUTS,
  type ToolName,
  type ToolResult,
  ulid,
} from "@localdot/protocol";
import type { ToolPolicy } from "../policy.ts";
import type { Redactor } from "../redact.ts";
import type { AgentSession, BrainGeneration, ToolLease } from "../session.ts";
import { askUserTool, requestTakeoverTool } from "./ask.ts";
import { browserNavigateTool, browserReadTool } from "./browser.ts";
import { computerTool } from "./computer.ts";
import { append, fail, type ToolCallContext, type ToolDeps } from "./deps.ts";
import { doneTool } from "./done.ts";
import { filesTool } from "./files.ts";
import { updatePlanTool } from "./plan.ts";
import { rememberTool } from "./remember.ts";
import { shellTool } from "./shell.ts";

// Daemon-side cap on one task's tool calls: the brain has its own turn limit, but the brain is in a
// cell, and enforcement lives outside the cells (trust rule 5); keyd's budget caps the spend.
export const MAX_TOOL_CALLS = 400;

export interface DispatchDeps {
  tools: ToolDeps;
  policy: ToolPolicy;
  maxToolCalls?: number;
}

export type DispatchOutcome = { status: 200 | 400 | 404; result: ToolResult };

const STEP_KIND: Record<ToolName, string> = {
  computer: "gui",
  shell: "shell",
  files: "file",
  browser_read: "browser",
  browser_navigate: "browser",
  update_plan: "think",
  ask_user: "ask",
  request_takeover: "ask",
  remember: "think",
  done: "think",
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

// One tool call from the brain: the v1 table, the input's schema, the daemon's call cap and the
// policy seam come first, in that order; only then does anything reach the computer or the user.
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
    session.toolCalls += 1;
    if (session.toolCalls > (deps.maxToolCalls ?? MAX_TOOL_CALLS)) {
      blocked(
        session,
        name,
        STEP_KIND[name],
        "Tool call limit",
        "this task used all its tool calls",
      );
      return {
        status: 200,
        result: {
          ok: false,
          final: true,
          content: [
            {
              type: "text",
              text: "This task has used all its tool calls. Stop and tell the user what is left.",
            },
          ],
        },
      };
    }
    const decision = await deps.policy.decide({
      sessionId: session.id,
      tool: name,
      input: parsed.data,
      tainted: session.tainted,
    });
    ctx.check();
    if (decision.kind !== "act") {
      const note = redact(
        decision.kind === "ask" ? `needs approval: ${decision.reason}` : decision.reason,
      );
      blocked(session, name, STEP_KIND[name], `Refused ${name}`, note);
      return { status: 200, result: fail(`Refused by localDot's rules: ${note}`) };
    }
    const t = deps.tools,
      input = parsed.data as never;
    switch (name) {
      case "computer":
        append(ctx, "step.start", { kind: "gui" });
        result = await computerTool(t, ctx, input);
        ctx.check();
        append(ctx, "step.end", { status: result.ok ? "ok" : "failed" });
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
      case "done":
        result = await doneTool(t, ctx, input);
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
    lease?.finish();
  }
}
