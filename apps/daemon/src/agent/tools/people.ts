import { clipText, type PeopleInput, type ToolResult } from "@localdot/protocol";
import { namedIn, PeopleError, type PeopleStore, type StoredPerson } from "../people.ts";
import type { AgentSession } from "../session.ts";
import { untrusted } from "../untrusted.ts";
import { append, fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

const FOUND = 8;
export const SAVE_UNNAMED =
  "Save someone only under a name the user wrote in this task, or ask the user to confirm first.";
export const SAVE_REDIRECT =
  "Someone by this name is already saved with another app, handle or note. Ask the user before changing how to reach them.";

const line = (p: StoredPerson) =>
  [
    p.name,
    p.handle ? `${p.app}: ${p.handle}` : p.app,
    ...(p.note ? [p.note] : []),
    p.lastAt ? `last ${p.lastAt}` : "never reached through dot",
  ].join(" · ");

// After something other than the user reached the model, dot may only save people the user named,
// and only as new or as they are saved: a page can't plant a contact, redirect one or rewrite its
// note.
export function saveRefusal(
  session: AgentSession,
  input: PeopleInput,
  people?: Pick<PeopleStore, "redirects">,
): string | undefined {
  if (input.op !== "save" || !session.tainted) return undefined;
  if (!namedIn(session.requests, input.name ?? "")) return SAVE_UNNAMED;
  if (!people || !input.name || !input.app) return undefined;
  try {
    const fields = {
      name: input.name,
      app: input.app,
      handle: input.handle ?? null,
      note: input.note ?? null,
    };
    return people.redirects(fields) ? SAVE_REDIRECT : undefined;
  } catch (error) {
    if (error instanceof PeopleError) return undefined;
    throw error;
  }
}

export async function peopleTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: PeopleInput,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  const people = deps.people;
  if (!people) return fail("The people dot knows are not available.");
  if (input.op === "find") {
    if (!input.query) return fail("Give query: a name, app or handle to look up.");
    const query = ctx.redact(input.query);
    append(ctx, "step.start", { kind: "think" });
    append(ctx, "tool.start", { tool: "people", title: clipText(`Look up ${query}`, 200) });
    const found = people.find(query, FOUND);
    const body = found.length ? found.map(line).join("\n") : "No one by that name yet.";
    ctx.session.tainted = true;
    if (found.length) ctx.session.taint.add("memory", "people", body);
    ctx.check();
    append(ctx, "tool.end", { ok: true });
    append(ctx, "step.end", { status: "ok" });
    return { ok: true, content: [text(untrusted("people the user reaches", ctx.redact(body)))] };
  }
  if (!input.name || !input.app) return fail("Give name and app to save someone.");
  const refusal = saveRefusal(ctx.session, input, people);
  if (refusal) return fail(refusal);
  const name = ctx.redact(input.name);
  append(ctx, "step.start", { kind: "think" });
  append(ctx, "tool.start", {
    tool: "people",
    title: clipText(`Remember ${name} on ${ctx.redact(input.app)}`, 200),
  });
  try {
    const { person } = people.record(ctx.session.id, {
      name,
      app: ctx.redact(input.app),
      ...(input.handle ? { handle: ctx.redact(input.handle) } : {}),
      ...(input.note ? { note: ctx.redact(input.note) } : {}),
    });
    ctx.check();
    append(ctx, "tool.end", { ok: true });
    append(ctx, "step.end", { status: "ok" });
    return { ok: true, content: [text(`Saved ${person.name} (${person.app}).`)] };
  } catch (error) {
    append(ctx, "tool.end", { ok: false });
    append(ctx, "step.end", { status: "failed" });
    if (error instanceof PeopleError) return fail(ctx.redact(error.message));
    throw error;
  }
}
