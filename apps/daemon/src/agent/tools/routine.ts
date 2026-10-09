import type {
  FollowUpAtInput,
  MissedPolicy,
  RoutineNotify,
  RoutineProfile,
  RoutineState,
  RoutineToolInput,
  RoutineToolWhen,
  ToolResult,
} from "@localdot/protocol";
import { RoutineError } from "../../routines/store.ts";
import { append, fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

export interface RoutineProposal {
  routineId: string;
  revision: number;
  name: string;
  summary: string;
  instruction: string;
  profile: RoutineProfile;
  notify: RoutineNotify;
  budgetUSD: number | null;
  approvalWindowMinutes: number;
  missedPolicy: MissedPolicy;
}
export interface RoutineToolPort {
  propose(
    sessionId: string,
    input: {
      name: string;
      instruction: string;
      when: RoutineToolWhen;
      notify?: RoutineNotify;
      profile?: "ask_first" | "read_only";
    },
  ): RoutineProposal;
  list(): {
    id: string;
    name: string;
    summary: string;
    state: RoutineState;
    nextDueAt: string | null;
  }[];
  pause(routineId: string): boolean;
  followUp(sessionId: string, at: string, note: string): { routineId: string; summary: string };
}

export async function routineTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: RoutineToolInput,
): Promise<ToolResult> {
  ctx.check();
  const port = deps.routines;
  if (!port) return fail("Routines are not available here.");
  try {
    if (input.op === "list") {
      const rows = port.list();
      return {
        ok: true,
        content: [
          text(
            rows.length
              ? rows
                  .map(
                    (r) =>
                      `- ${r.id} ${r.name}: ${r.summary}, ${r.state}${r.nextDueAt ? `, next ${r.nextDueAt}` : ""}`,
                  )
                  .join("\n")
              : "There are no routines.",
          ),
        ],
      };
    }
    if (input.op === "pause") {
      if (!input.routine_id) return fail("Give routine_id to pause a routine.");
      return port.pause(input.routine_id)
        ? { ok: true, content: [text("Paused.")] }
        : fail("No active routine has that id.");
    }
    if (!input.name || !input.instruction || !input.when)
      return fail("To propose a routine, give name, instruction and when.");
    const proposal = port.propose(ctx.session.id, {
      name: ctx.redact(input.name),
      instruction: ctx.redact(input.instruction),
      when: input.when,
      ...(input.notify ? { notify: input.notify } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
    });
    append(ctx, "routine.proposed", { ...proposal });
    return {
      ok: true,
      content: [
        text(
          `Proposed "${proposal.name}" (${proposal.summary}). It will not run until the user presses Save routine on the card. Tell them briefly what it will do and when.`,
        ),
      ],
    };
  } catch (error) {
    if (error instanceof RoutineError) return fail(error.message);
    throw error;
  }
}

export async function followUpAtTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: FollowUpAtInput,
): Promise<ToolResult> {
  ctx.check();
  if (!deps.routines) return fail("Follow-ups are not available here.");
  try {
    const scheduled = deps.routines.followUp(ctx.session.id, input.at, ctx.redact(input.note));
    return { ok: true, content: [text(`I'll come back to this: ${scheduled.summary}.`)] };
  } catch (error) {
    if (error instanceof RoutineError) return fail(error.message);
    throw error;
  }
}
