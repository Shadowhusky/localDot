import type {
  AskRequestField,
  AskUserInput,
  RequestTakeoverInput,
  ToolResult,
} from "@localdot/protocol";
import { PausedStepError } from "../safety/step-barrier.ts";
import type { AgentSession, AskAnswer } from "../session.ts";
import { fail, frame, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
import { findSecretField, type SecretField, typeSecret } from "./secret-field.ts";

const reusedLogins = new WeakMap<AgentSession, Set<string>>();

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

// A routine's question waits for its own window, so the run is Needs you until then.
function askTimeoutMs(deps: ToolDeps, ctx: ToolCallContext): number {
  return deps.askTimeoutMs ?? ctx.session.approvalWindowMs ?? ASK_TIMEOUT_MS;
}

function unanswered(answer: AskAnswer, timeoutMs: number): ToolResult | undefined {
  if (answer.by === "pause")
    return {
      ok: false,
      pause: true,
      content: [text("The task was paused while waiting for an answer.")],
    };
  if (answer.by === "timeout")
    return {
      ok: false,
      content: [text(`The user did not answer within ${Math.round(timeoutMs / 60_000)} minutes.`)],
    };
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
  const timeoutMs = askTimeoutMs(deps, ctx);
  const answer = await ctx.session.ask(
    ctx.redact(input.question),
    options,
    input.allow_text ?? options.length === 0,
    timeoutMs,
    ctx.step,
    ctx.generation,
    ctx.signal,
  );
  ctx.check();
  const early = unanswered(answer, timeoutMs);
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
  // Saved credentials stay on the trusted input channel. Reuse once per task/site;
  // another request after a rejected login lets the user replace the saved password.
  const used = reusedLogins.get(ctx.session) ?? new Set<string>();
  reusedLogins.set(ctx.session, used);
  const loginFields = fields.filter((field) => field.kind !== "secret");
  const canReuse =
    secrets.size === 1 &&
    loginFields.every(
      (field) =>
        (field.kind === "text" || field.kind === "email") &&
        /user|email|account|login/iu.test(`${field.id} ${field.label}`),
    );
  const [secretEntry] = secrets;
  if (canReuse && secretEntry?.[1].loginOrigin && deps.logins) {
    const [id, field] = secretEntry;
    const origin = secretEntry[1].loginOrigin;
    if (!used.has(origin)) {
      const saved = await deps.logins.login(origin).catch(() => undefined);
      ctx.check();
      if (
        saved &&
        (saved.username || loginFields.length === 0) &&
        loginFields.every((field) => !field.value || field.value === saved.username)
      ) {
        used.add(origin);
        try {
          const landed = await typeSecret(deps, ctx, field, saved.password, saved.username);
          ctx.check();
          if (!landed)
            return fail(
              "The saved sign-in could not reach the password field. Check the current page and locate its password field again.",
            );
          ctx.session.taskAutonomy.signIn(field.screen.name);
          const answers = Object.fromEntries(
            loginFields.map((field) => [field.id, ctx.redact(saved.username)]),
          );
          return {
            ok: true,
            content: [
              text(
                `Used the saved sign-in for ${origin}. The password was filled privately. Account fields: ${JSON.stringify(answers)}. ${id}: provided. The account and password were filled and the sign-in form was submitted. Check the resulting page for success, an error, or two-factor authentication; do not submit again. If the site rejects these credentials, ask again so the user can update them.`,
              ),
            ],
          };
        } catch {
          ctx.check();
          return fail(
            "Secure delivery of the saved sign-in could not be confirmed. Inspect the page before retrying; do not claim the field moved.",
          );
        } finally {
          saved.password = "";
        }
      }
    }
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
      ...(where?.loginOrigin && deps.logins
        ? {
            hint: `Saved securely for ${new URL(where.loginOrigin).host} and reused for future sign-ins.`,
          }
        : field.hint
          ? { hint: ctx.redact(field.hint) }
          : {}),
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
  const timeoutMs = askTimeoutMs(deps, ctx);
  const answer = await ctx.session.askFields(
    {
      question: ctx.redact(input.question),
      fields: fields.map(shown),
      ...(input.submit ? { submit: ctx.redact(input.submit) } : {}),
      ...(input.decline ? { decline: ctx.redact(input.decline) } : {}),
    },
    timeoutMs,
    ctx.step,
    ctx.generation,
    ctx.signal,
  );
  const typed = answer.secrets;
  try {
    ctx.check();
    const early = unanswered(answer, timeoutMs);
    if (early) return early;
    const answers: Record<string, unknown> = { ...answer.fields };
    const moved: string[] = [];
    let saveFailed = false;
    for (const [id, field] of secrets) {
      const value = typed?.take(id);
      let landed = false;
      let username: string | undefined;
      if (value !== undefined && field.loginOrigin && deps.logins) {
        const accountFields = loginFields.filter(
          (field) =>
            (field.kind === "text" || field.kind === "email") &&
            /user|email|account|login/iu.test(`${field.id} ${field.label}`),
        );
        const account =
          accountFields.length === 1 && accountFields[0]
            ? answer.fields?.[accountFields[0].id]
            : undefined;
        // A password-only retry retains the account saved with the original answer.
        const prior =
          typeof account === "string"
            ? undefined
            : await deps.logins.login(field.loginOrigin).catch(() => undefined);
        ctx.check();
        username = typeof account === "string" ? account : (prior?.username ?? "");
        if (prior) prior.password = "";
        try {
          await deps.logins.saveLogin(field.loginOrigin, username ?? "", value);
        } catch {
          saveFailed = true;
        }
        ctx.check();
      }
      try {
        if (value !== undefined) landed = await typeSecret(deps, ctx, field, value, username);
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
            `The secure answer was not delivered. Check the page and locate the password field again; saved credentials can be reused without asking for the password again. Nothing was typed for ${moved.join(", ")}. The user's other answers: ${given}`,
          ),
        ],
      };
    return {
      ok: true,
      content: [
        text(
          `The user answered: ${given}${
            secrets.size
              ? "\nSecret answers were entered privately. For a saved browser sign-in, the account and password were filled and its sign-in form was submitted. Check the resulting page for success, an error, or two-factor authentication; do not submit it again."
              : ""
          }${saveFailed ? "\nThe password could not be saved for future sign-ins; tell the user." : secrets.size && [...secrets.values()].some((field) => field.loginOrigin) && deps.logins ? "\nThe sign-in was saved securely for future use on this site." : ""}`,
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
  const note = outcome.note ? ` Their note: ${outcome.note}` : "";
  return {
    ok: true,
    content: [
      text(
        ctx.redact(
          outcome.declined
            ? `The user said not now: they won't do this on the computer at the moment.${note} Don't hand the screen over again for it right away: find another way, or carry on with the rest and tell them what is left for them.`
            : `The user handed the screen back.${note}`,
        ),
      ),
      image,
    ],
  };
}
