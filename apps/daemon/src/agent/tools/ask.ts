import {
  ASK_ANSWER_ID,
  type AskFieldRecord,
  type AskRequestField,
  type AskUserInput,
  isOwnWords,
  type RequestTakeoverInput,
  type ToolResult,
} from "@localdot/protocol";
import { addTaskSecret } from "../redact.ts";
import { PausedStepError } from "../safety/step-barrier.ts";
import type { AgentSession, AskAnswer, AskForm } from "../session.ts";
import { fail, frame, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
import { accountOrigin, findSecretField, type SecretField, typeSecret } from "./secret-field.ts";

const reusedLogins = new WeakMap<AgentSession, Set<string>>();

const ASK_TIMEOUT_MS = 30 * 60_000;
const DECLINED =
  "The user declined (Not now). Do not ask for this again unless the user brings it up; continue without it, or finish and say what is left.";
const SKIPPED =
  "Skipped questions are optional: use your recommended or default choice, state it as an assumption, and don't ask again unless you're blocked.";

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

// A quick choice, or a question with nothing to fill in, as the one field it is answered in: an
// option, the user's own words, or nothing, which leaves it to dot.
export function plainForm(input: AskUserInput, redact: (text: string) => string): AskForm {
  const options = input.options?.map(redact);
  return {
    question: redact(input.question),
    fields: [
      {
        id: ASK_ANSWER_ID,
        kind: options ? "choice" : "longtext",
        label: "Your answer",
        ...(options ? { options } : {}),
        ...(input.recommended === undefined ? {} : { recommended: input.recommended }),
        required: false,
      },
    ],
    ...(input.submit ? { submit: redact(input.submit) } : {}),
    ...(input.decline ? { decline: redact(input.decline) } : {}),
  };
}

// How an answer reads to dot: what was typed as it is, picked options as `selected` and the
// user's own words as `other`.
function shownAnswer(field: Pick<AskRequestField, "kind">, value: AskFieldRecord): unknown {
  if (field.kind === "choice" && typeof value === "string") return { selected: [value] };
  if (field.kind === "multichoice" && Array.isArray(value)) return { selected: value };
  return value;
}

export async function askUserTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: AskUserInput,
): Promise<ToolResult> {
  ctx.check();
  if (input.fields) return askFields(deps, ctx, input, input.fields);
  const form = plainForm(input, ctx.redact);
  const timeoutMs = askTimeoutMs(deps, ctx);
  const answer = await ctx.session.askFields(form, timeoutMs, ctx.step, ctx.generation, ctx.signal);
  ctx.check();
  const early = unanswered(answer, timeoutMs);
  if (early) return early;
  // Read as the lettered choice dot has always been told, which older brains still look for.
  const given = answer.fields?.[ASK_ANSWER_ID];
  const options = form.fields[0]?.options ?? [];
  const picked = typeof given === "string" ? options.indexOf(given) : -1;
  const said =
    picked >= 0
      ? `The user chose ${"ABCDEF"[picked]}: ${given}`
      : isOwnWords(given)
        ? `The user wrote: ${given.other}`
        : typeof given === "string"
          ? `The user wrote: ${given}`
          : `The user skipped the question.\n${SKIPPED}`;
  return { ok: true, content: [text(ctx.redact(said))] };
}
// A question answered per field. Secret answers are typed into the fields dot named and come back
// to the model only as { provided: true }; a field that moved meanwhile gets nothing typed.
async function askFields(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: AskUserInput,
  fields: NonNullable<AskUserInput["fields"]>,
): Promise<ToolResult> {
  if (
    input.purpose === "sign_in" &&
    fields.length === 1 &&
    deps.logins &&
    (fields[0]?.kind === "text" || fields[0]?.kind === "email")
  ) {
    const origin = await accountOrigin(deps, ctx);
    if (origin) {
      let saved: Awaited<ReturnType<NonNullable<ToolDeps["logins"]>["login"]>>;
      try {
        saved = await deps.logins.login(origin);
      } catch {
        ctx.check();
        return fail(
          "The saved sign-in store is temporarily unavailable. Do not request credentials again; explain the access problem.",
        );
      }
      ctx.check();
      if (saved) {
        saved.password = "";
        if (saved.username)
          return {
            ok: true,
            content: [
              text(
                `Saved account for ${origin}: ${JSON.stringify({ [fields[0].id]: ctx.redact(saved.username) })}. Fill the current account field, continue, and inspect the next step. The password remains private.`,
              ),
            ],
          };
      }
    }
  }
  const secrets = new Map<string, SecretField>();
  for (const field of fields) {
    if (field.kind !== "secret" && field.kind !== "code") continue;
    const found = await findSecretField(deps, ctx, field.target, field.kind);
    if (typeof found === "string") return fail(found);
    // Saved sign-ins are read and kept only for a password on the web browser screen.
    secrets.set(
      field.id,
      field.kind === "secret" && found.screen.name === "browser"
        ? found
        : { ...found, loginOrigin: undefined },
    );
  }
  // Saved credentials stay on the trusted input channel. Reuse once per task/site;
  // another request after a rejected login lets the user replace the saved password.
  const used = reusedLogins.get(ctx.session) ?? new Set<string>();
  reusedLogins.set(ctx.session, used);
  const loginFields = fields.filter((field) => field.kind !== "secret" && field.kind !== "code");
  const canReuse =
    secrets.size === 1 &&
    loginFields.length <= 1 &&
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
      let saved: Awaited<ReturnType<NonNullable<ToolDeps["logins"]>["login"]>>;
      try {
        saved = await deps.logins.login(origin);
      } catch {
        ctx.check();
        return fail(
          "The saved sign-in store is temporarily unavailable. Do not ask the user to enter credentials again or treat this as a rejected password. Explain that saved credentials could not be checked and retry after access is restored.",
        );
      }
      ctx.check();
      if (saved && loginFields.every((field) => !field.value || field.value === saved.username)) {
        let delivering = false;
        try {
          if (!saved.username && loginFields.length) {
            const missing = await ctx.session.askFields(
              {
                question: `A password is saved for ${new URL(origin).host}. Which account should it use?`,
                fields: loginFields.map((field) => ({
                  id: field.id,
                  kind: field.kind,
                  label: ctx.redact(field.label),
                  required: true,
                })),
                submit: input.submit ?? "Continue",
                decline: input.decline ?? "Not now",
              },
              askTimeoutMs(deps, ctx),
              ctx.step,
              ctx.generation,
              ctx.signal,
            );
            ctx.check();
            const early = unanswered(missing, askTimeoutMs(deps, ctx));
            if (early) return early;
            const account = loginFields[0] && missing.fields?.[loginFields[0].id];
            if (typeof account !== "string") return fail("The account name was not provided.");
            saved.username = account;
            await deps.logins.saveLogin(origin, saved.username, saved.password);
          }
          delivering = true;
          addTaskSecret(ctx.session, saved.password);
          const landed = await typeSecret(deps, ctx, field, saved.password, saved.username);
          ctx.check();
          if (!landed.filled)
            return fail(
              "The saved sign-in could not reach the password field. Check the current page and locate its password field again.",
            );
          used.add(origin);
          ctx.session.taskAutonomy.signIn(field.screen.name);
          const answers = Object.fromEntries(
            loginFields.map((field) => [field.id, ctx.redact(saved.username)]),
          );
          return {
            ok: true,
            content: [
              text(
                `Used the saved sign-in for ${origin}. The password was filled privately. Account fields: ${JSON.stringify(answers)}. ${id}: provided. ${landed.submitted ? "The sign-in form was submitted. Do not submit again." : "Submission was not confirmed. Inspect the current page before any further action."} Check the resulting page for success, an error, or another authentication step. If the site rejects these credentials, ask again so the user can update them.`,
              ),
            ],
          };
        } catch {
          if (delivering) used.add(origin);
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
  let knownAccount: string | undefined;
  if (
    canReuse &&
    secretEntry?.[1].loginOrigin &&
    deps.logins &&
    used.has(secretEntry[1].loginOrigin)
  ) {
    try {
      const prior = await deps.logins.login(secretEntry[1].loginOrigin);
      knownAccount = loginFields.every((field) => !field.value || field.value === prior?.username)
        ? prior?.username || undefined
        : undefined;
      if (prior) prior.password = "";
    } catch {
      // A replacement can still be supplied; failure to save it is reported below.
    }
    ctx.check();
  }
  const promptedFields = knownAccount
    ? fields.filter((field) => !loginFields.includes(field))
    : fields;
  // Signing in and verifying need every answer, and a lone confirm is the answer itself.
  const signing =
    input.purpose !== undefined ||
    fields.some((field) => field.kind === "secret" || field.kind === "code");
  const required = (field: (typeof fields)[number]) =>
    field.required === true || signing || (fields.length === 1 && field.kind === "confirm");
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
      ...(field.recommended === undefined ? {} : { recommended: field.recommended }),
      required: required(field),
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
      fields: promptedFields.map(shown),
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
    const answers: Record<string, unknown> = {};
    for (const field of fields) {
      const value =
        knownAccount && loginFields.includes(field)
          ? ctx.redact(knownAccount)
          : answer.fields?.[field.id];
      if (value !== undefined) answers[field.id] = shownAnswer(field, value);
      else if (answer.skipped?.includes(field.id)) answers[field.id] = { skipped: true };
    }
    const moved: string[] = [];
    const deliveries: string[] = [];
    let saveFailed = false;
    for (const [id, field] of secrets) {
      const value = typed?.take(id);
      if (value !== undefined) addTaskSecret(ctx.session, value);
      let landed = { filled: false, submitted: false };
      let username: string | undefined;
      if (value !== undefined && field.loginOrigin && deps.logins) {
        const accountFields = loginFields.filter(
          (field) =>
            (field.kind === "text" || field.kind === "email") &&
            /user|email|account|login/iu.test(`${field.id} ${field.label}`),
        );
        const account =
          accountFields.length === 1 && accountFields[0]
            ? (knownAccount ?? answer.fields?.[accountFields[0].id])
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
      if (landed.filled) {
        deliveries.push(
          `${id}: entered privately; ${landed.submitted ? "submitted once, do not submit again" : "submission not confirmed, inspect the page before acting"}.`,
        );
        ctx.session.taskAutonomy.signIn(field.screen.name);
        // Asking again after a delivered login means the site rejected it. Do not replay
        // the just-saved password; collect a replacement on the private channel.
        if (field.loginOrigin) used.add(field.loginOrigin);
      } else {
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
            `The secure answer was not delivered. Check the page and locate the password or verification field again; saved credentials can be reused without asking for the password again. Nothing was typed for ${moved.join(", ")}. The user's other answers: ${given}`,
          ),
        ],
      };
    return {
      ok: true,
      content: [
        text(
          `The user answered: ${given}${answer.skipped?.length ? `\n${SKIPPED}` : ""}${
            secrets.size
              ? `\n${deliveries.join("\n")} Verification codes are never saved. The page may advance after the last character; inspect it and never replay a code after it advances. A rejected password needs a replacement; a different verification step needs the matching input form.`
              : ""
          }${saveFailed ? "\nThe password could not be saved for future sign-ins; tell the user." : secrets.size && [...secrets.values()].some((field) => field.loginOrigin) && deps.logins ? "\nThe sign-in was saved securely for future use on this site." : secrets.size && fields.some((field) => field.kind === "secret") && ![...secrets.values()].some((field) => field.loginOrigin) ? "\nThis password was entered once but was not saved: this surface did not provide a verified website sign-in form. Tell the user it will need to be provided again if this sign-in is lost." : ""}`,
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
  // The session posts their note as their message; saying it here too would hand it over twice.
  const note = outcome.note ? " Their note follows as their next message." : "";
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
