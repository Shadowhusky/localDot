import type { RememberInput, ToolResult } from "@localdot/protocol";
import { MemoryError } from "../memory.ts";
import { askChoice } from "./ask.ts";
import { append, contain, fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

const WHERE: Record<RememberInput["file"], string> = {
  "USER.md": "what I remember about you",
  "MEMORY.md": "what I remember",
  notes: "today's notes",
};
const tokens = (text: string) =>
  [...text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].flatMap(([word]) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)
      ? [...word]
      : [word],
  );
// What dot would save is the user's own words from this task, give or take a few of dot's: most of
// its words are theirs. Nothing a page said passes, unless the user said it too.
export function inUsersWords(text: string, requests: readonly string[]): boolean {
  const wanted = tokens(text);
  if (wanted.length < 4) return false;
  const said = new Set(requests.flatMap(tokens));
  return wanted.filter((word) => said.has(word)).length / wanted.length >= 0.7;
}
// A task that has read outside words can't write memory on its own say-so: a page could have
// planted the "fact". The user is shown exactly what would be saved, and their yes is their own
// word. Nothing to tell dot when they said yes; otherwise what it is told instead of saving.
export async function confirmMemory(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: RememberInput,
): Promise<ToolResult | undefined> {
  const shown = ctx.redact(input.text).trim();
  const picked = await askChoice(
    deps,
    ctx,
    `Save this to ${WHERE[input.file]}?\n\n${shown.length > 800 ? `${shown.slice(0, 799)}…` : shown}`,
    ["Save it", "Don't save"],
  );
  if (typeof picked !== "number") return picked;
  return picked === 0
    ? undefined
    : fail("The user chose not to save that. Don't ask again; carry on with the task.");
}
export async function rememberTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: RememberInput,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  if (ctx.session.tainted && !inUsersWords(input.text, ctx.session.requests))
    return fail(
      "Memory can only be saved from the user's own request or reply. Ask the user to confirm the fact first.",
    );
  if (input.file === "notes" && input.op !== "append")
    return fail('Daily notes are append-only. Use op "append".');
  try {
    ctx.check();
    const change =
      input.file === "notes"
        ? deps.memory.appendNote(ctx.session.id, ctx.redact(input.text))
        : deps.memory.apply(
            ctx.session.id,
            input.file,
            input.op,
            ctx.redact(input.text),
            input.old_text === undefined ? undefined : ctx.redact(input.old_text),
          );
    ctx.check();
    append(ctx, "memory.change", {
      file: change.file,
      patch: change.patch,
      changeId: change.changeId,
    });
    return {
      ok: true,
      content: [
        text(input.file === "notes" ? "Saved to today's notes." : `Saved to ${input.file}.`),
      ],
    };
  } catch (error) {
    if (error instanceof MemoryError) return fail(ctx.redact(error.message));
    return contain(deps, ctx, "memory_write_uncertain");
  }
}
