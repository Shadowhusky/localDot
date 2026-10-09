import type {
  AskRequestField,
  AskUserInput,
  RequestTakeoverInput,
  ToolResult,
} from "@localdot/protocol";
import { PausedStepError } from "../safety/step-barrier.ts";
import type { AskAnswer } from "../session.ts";
import { fail, frame, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
import { findSecretField, type SecretField, typeSecret } from "./secret-field.ts";

const ASK_TIMEOUT_MS = 30 * 60_000;
const DECLINED =
  "The user declined (Not now). Do not ask for this again unless the user brings it up; continue without it, or finish and say what is left.";

// The site whose page holds the field, so the user sees where the password goes.
function siteOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol, host } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return undefined;
    return host && host.length <= 255 ? host : undefined;
  } catch {
    return undefined;
  }
}

function unanswered(answer: AskAnswer): ToolResult | undefined {
  if (answer.by === "pause")
    return {
      ok: false,
      pause: true,
      content: [text("The task was paused while waiting for an answer.")],
    };
  if (answer.by === "timeout")
    return { ok: false, content: [text("The user did not answer within 30 minutes.")] };
  if (answer.by === "stop") return { ok: false, content: [text("The question was cancelled.")] };
  if (answer.by === "control")
    return { ok: false, content: [text("The user took the computer instead of answering.")] };
  if (answer.declined) return { ok: true, content: [text(DECLINED)] };
  return undefined;
}

export async function askUserTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: AskUserInput,
): Promise<ToolResult> {
  ctx.check();
  if (input.fields) return askFields(deps, ctx, input, input.fields);
  const options = (input.options ?? []).map(ctx.redact);
  const answer = await ctx.session.ask(
    ctx.redact(input.question),
    options,
    input.allow_text ?? options.length === 0,
    deps.askTimeoutMs ?? ASK_TIMEOUT_MS,
    ctx.step,
    ctx.generation,
    ctx.signal,
  );
  ctx.check();
  const early = unanswered(answer);
  if (early) return early;
  const picked = answer.option ? options["ABCDEF".indexOf(answer.option)] : undefined;
  return {
    ok: true,
    content: [
      text(
        ctx.redact(
          [
            picked ? `The user chose ${answer.option}: ${picked}` : undefined,
            answer.text ? `The user wrote: ${answer.text}` : undefined,
          ]
            .filter(Boolean)
            .join("\n") || "The user answered without text.",
        ),
      ),
    ],
  };
}
// A question answered per field. Secret answers are typed into the fields dot named and come back
// to the model only as { provided: true }; a field that moved meanwhile gets nothing typed.
async function askFields(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: AskUserInput,
  fields: NonNullable<AskUserInput["fields"]>,
): Promise<ToolResult> {
  const secrets = new Map<string, SecretField>();
  for (const field of fields) {
    if (field.kind !== "secret") continue;
    const found = await findSecretField(deps, ctx, field.target);
    if (typeof found === "string") return fail(found);
    secrets.set(field.id, found);
  }
  ctx.check();
  const shown = (field: (typeof fields)[number]): AskRequestField => {
    const where = secrets.get(field.id);
    const target = where?.found.target;
    const site = siteOf(target?.url);
    return {
      id: field.id,
      kind: field.kind,
      label: ctx.redact(field.label),
      ...(field.hint ? { hint: ctx.redact(field.hint) } : {}),
      ...(field.options ? { options: field.options.map(ctx.redact) } : {}),
      ...(field.length ? { length: field.length } : {}),
      ...(field.value ? { value: ctx.redact(field.value) } : {}),
      ...(where && target
        ? {
            target: {
              screen: where.screen.name,
              point: where.at ?? target.point,
              ...(target.bbox ? { bbox: target.bbox } : {}),
              ...(site ? { site } : {}),
            },
          }
        : {}),
    };
  };
  const answer = await ctx.session.askFields(
    {
      question: ctx.redact(input.question),
      fields: fields.map(shown),
      ...(input.submit ? { submit: ctx.redact(input.submit) } : {}),
      ...(input.decline ? { decline: ctx.redact(input.decline) } : {}),
    },
    deps.askTimeoutMs ?? ASK_TIMEOUT_MS,
    ctx.step,
    ctx.generation,
    ctx.signal,
  );
  const typed = answer.secrets;
  try {
    ctx.check();
    const early = unanswered(answer);
    if (early) return early;
    const answers: Record<string, unknown> = { ...answer.fields };
    const moved: string[] = [];
    for (const [id, field] of secrets) {
      const value = typed?.take(id);
      let landed = false;
      try {
        if (value !== undefined) landed = await typeSecret(deps, ctx, field, value);
      } catch {
        ctx.session.taskAutonomy.signIn(field.screen.name);
        ctx.check();
        // A device's own error text never travels on: it could quote what was typed.
        throw new Error(
          `Typing the answer for ${id} could not be confirmed. Take a screenshot before you continue.`,
        );
      }
      // Credentials went into this screen, as after the user's own sign-in.
      if (landed) ctx.session.taskAutonomy.signIn(field.screen.name);
      else {
        moved.push(id);
        delete answers[id];
      }
    }
    ctx.check();
    const given = JSON.stringify(answers);
    if (moved.length)
      return {
        ok: false,
        content: [
          text(
            `The field moved; ask again. Nothing was typed for ${moved.join(", ")}. The user's other answers: ${given}`,
          ),
        ],
      };
    return {
      ok: true,
      content: [
        text(
          `The user answered: ${given}${
            secrets.size
              ? "\nSecret answers were typed into the fields you named; you never see them. Take a screenshot before you continue."
              : ""
          }`,
        ),
      ],
    };
  } finally {
    typed?.clear();
  }
}

export async function requestTakeoverTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: RequestTakeoverInput,
): Promise<ToolResult> {
  ctx.check();
  // A held Pause refuses the hand-off before anything counts as signed in.
  if (ctx.session.safetyPause) throw new PausedStepError();
  // The user gets every screen during a takeover, so a sign-in may land on the desktop.
  if (input.reason !== "other") ctx.session.taskAutonomy.signIn("desktop");
  const outcome = await ctx.session.takeover(
    input.reason,
    ctx.redact(input.note),
    ctx.step,
    ctx.lease,
  );
  ctx.check();
  if (outcome.by !== "user") return { ok: false, content: [text("The hand-back was cancelled.")] };
  const o = await deps.gateway.observe({
    sessionId: ctx.session.id,
    cellId: ctx.session.cellId,
    step: ctx.step,
    signal: ctx.signal,
  });
  ctx.check();
  const image = await frame(deps, ctx, o.frameId);
  ctx.check();
  return {
    ok: true,
    content: [
      text(
        ctx.redact(
          `The user handed the screen back.${outcome.note ? ` Their note: ${outcome.note}` : ""}`,
        ),
      ),
      image,
    ],
  };
}
