import {
  ASK_ANSWER_ID,
  type AskFieldKind,
  type AskFieldValue,
  askRequired,
  askValueProblem,
  type CredentialRequest,
  isOwnWords,
  type QuestionAnswerRequest,
} from "@localdot/protocol";
import type { AgentQuestion } from "./model.ts";

// One field of a question as every surface draws it. A plain question (lettered options and/or
// free text, asked before every question had fields) becomes one field of its own, so the thread,
// the island and the sheet share controls.
export interface AskField {
  readonly credential?: CredentialRequest;
  readonly id: string;
  readonly kind: AskFieldKind;
  readonly label: string;
  readonly hint?: string;
  readonly options: readonly string[];
  // The option dot recommends, by index: marked, never picked for the user.
  readonly recommended?: number;
  // A choice's or multichoice's own-words row ("Other…").
  readonly other: boolean;
  // Unanswered, it can't be sent; any other field the user may leave to dot.
  readonly required: boolean;
  // A code's cell count.
  readonly length?: number;
  // What a QR code holds.
  readonly value?: string;
  // A secret's site: whose page the field it is typed into is on.
  readonly site?: string;
}

// What a field holds while it is filled in. A choice holds the picked option's index as text, or
// OTHER once its own-words row has text; a multichoice holds the indexes picked, and its own words
// count beside them while they have text.
export type DraftValue = string | readonly string[] | boolean;
export interface Draft {
  readonly values: Readonly<Record<string, DraftValue>>;
  readonly other: Readonly<Record<string, string>>;
}

export const OTHER = "other";

// Typed answers the composer's message can be on its own.
const FREE_TEXT = new Set<AskFieldKind>([
  "text",
  "longtext",
  "number",
  "date",
  "email",
  "url",
  "phone",
]);

export function askFields(question: AgentQuestion): readonly AskField[] {
  if (question.fields?.length)
    return question.fields.map((field) => ({
      id: field.id,
      ...(field.credential ? { credential: field.credential } : {}),
      kind: field.kind,
      label: field.label,
      ...(field.hint ? { hint: field.hint } : {}),
      options: field.options ?? [],
      ...(field.recommended === undefined ? {} : { recommended: field.recommended }),
      other: field.kind === "choice" || field.kind === "multichoice",
      required: askRequired(field),
      ...(field.length ? { length: field.length } : {}),
      ...(field.value ? { value: field.value } : {}),
      ...(field.target?.site ? { site: field.target.site } : {}),
    }));
  return [
    {
      id: ASK_ANSWER_ID,
      kind: question.options.length ? "choice" : "longtext",
      label: "Your answer",
      options: question.options.map((option) => option.text),
      other: question.options.length > 0 && question.allowText,
      required: true,
    },
  ];
}

export const emptyDraft = (fields: readonly AskField[]): Draft => ({
  values: Object.fromEntries(
    fields.map((field) => [
      field.id,
      field.kind === "multichoice" ? [] : field.kind === "confirm" ? false : "",
    ]),
  ),
  other: {},
});

// A lone confirm is the submit button itself, as on the decision island; beside other fields it is
// a box to tick.
export const confirmsBySubmit = (fields: readonly AskField[]) =>
  fields.length === 1 && fields[0]?.kind === "confirm";

// A question whose one field is its plain answer: dot's question already names it.
export const plainAnswer = (fields: readonly AskField[]) =>
  fields.length === 1 && fields[0]?.id === ASK_ANSWER_ID;

// "(optional)" goes after a label only where the form mixes fields that need an answer with ones
// that don't; a QR code and a lone confirm have nothing to leave out.
export function marksOptional(fields: readonly AskField[]): boolean {
  const shown = fields.filter((field) => field.kind !== "qr" && !confirmsBySubmit(fields));
  return shown.some((field) => field.required) && shown.some((field) => !field.required);
}

// The value a field answers with, or undefined while it has none. A choice's own words go as its
// text, which every daemon takes; a multichoice's go beside its picks.
export function fieldValue(
  field: AskField,
  draft: Draft,
  fields: readonly AskField[] = [field],
): AskFieldValue | undefined {
  const value = draft.values[field.id];
  const words = draft.other[field.id]?.trim();
  switch (field.kind) {
    case "api_key":
      return value === true ? true : undefined;
    case "qr":
      return true;
    case "confirm":
      return value === true || confirmsBySubmit(fields) ? true : undefined;
    case "multichoice": {
      const marks = Array.isArray(value) ? value : [];
      const selected = field.options.filter((_, index) => marks.includes(String(index)));
      if (words) return selected.length ? { selected, other: words } : { other: words };
      return selected.length ? selected : undefined;
    }
    case "choice":
      if (value === OTHER) return words || undefined;
      return typeof value === "string" && value ? field.options[Number(value)] : undefined;
    case "secret":
      return typeof value === "string" && value ? value : undefined;
    default:
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
}

// Why a field can't be sent as it is, in the card's words: a value that doesn't fit, or nothing
// in a field that needs an answer. Undefined once it can.
export function fieldProblem(
  field: AskField,
  draft: Draft,
  fields: readonly AskField[] = [field],
): string | undefined {
  const value = fieldValue(field, draft, fields);
  if (value === undefined && !field.required) return undefined;
  return askValueProblem(field, value);
}

// Nothing filled in, and nothing that needs to be: sending leaves every field to dot.
export function leftToDot(fields: readonly AskField[], draft: Draft): boolean {
  return fields.every((field) => !field.required && fieldValue(field, draft, fields) === undefined);
}

// The request that answers the question from the draft, once every field can be sent.
export function answerRequest(
  question: AgentQuestion,
  fields: readonly AskField[],
  draft: Draft,
): QuestionAnswerRequest | undefined {
  if (fields.some((field) => fieldProblem(field, draft, fields))) return undefined;
  if (question.fields?.length) {
    const values: Record<string, AskFieldValue> = {};
    for (const field of fields) {
      const value = fieldValue(field, draft, fields);
      if (value !== undefined) values[field.id] = value;
    }
    return { askId: question.askId, fields: values };
  }
  const [field] = fields;
  if (!field) return undefined;
  const value = fieldValue(field, draft);
  if (typeof value !== "string") return undefined;
  if (field.kind === "choice" && draft.values[field.id] !== OTHER) {
    const option = question.options[Number(draft.values[field.id])];
    return option ? { askId: question.askId, option: option.key } : undefined;
  }
  return { askId: question.askId, text: value };
}

// What the composer does with a message while dot waits on a question: answer it when the message
// can be the whole answer, as a choice's own words or a lone field's value; otherwise turn the
// question down so dot reads the message, and any files with it, at once. A question with a secret
// holds the message, which would reach dot in plain text, and so does one that can only be
// answered.
export type ComposerReply =
  | { readonly kind: "answer"; readonly request: QuestionAnswerRequest }
  | { readonly kind: "decline"; readonly request: QuestionAnswerRequest }
  | { readonly kind: "hold"; readonly reason: string };

export function composerReply(
  question: AgentQuestion,
  text: string,
  attached = false,
): ComposerReply {
  if (
    question.fields?.some(
      (field) => field.kind === "secret" || field.kind === "code" || field.kind === "api_key",
    )
  )
    return {
      kind: "hold",
      reason: "Type it in dot's question above. Messages aren't kept secret.",
    };
  const decline: ComposerReply =
    question.declinable === false
      ? { kind: "hold", reason: "Answer dot's question above first. Your message stays here." }
      : { kind: "decline", request: { askId: question.askId, declined: true } };
  if (attached) return decline;
  const said = text.trim();
  if (!question.fields?.length) {
    const option = question.options.find(
      (choice) => choice.text.toLowerCase() === said.toLowerCase(),
    );
    if (option) return { kind: "answer", request: { askId: question.askId, option: option.key } };
    return question.allowText && said.length <= 2000
      ? { kind: "answer", request: { askId: question.askId, text: said } }
      : decline;
  }
  const [field] = askFields(question);
  if (question.fields.length !== 1 || !field) return decline;
  const option = field.options.find((choice) => choice.toLowerCase() === said.toLowerCase());
  const value: AskFieldValue | undefined =
    field.kind === "choice"
      ? (option ?? said)
      : field.kind === "multichoice"
        ? option
          ? [option]
          : { other: said }
        : FREE_TEXT.has(field.kind)
          ? said
          : undefined;
  return value === undefined || askValueProblem(field, value)
    ? decline
    : { kind: "answer", request: { askId: question.askId, fields: { [field.id]: value } } };
}

const SECRET_SHOWN = "kept secret";
export const LEFT_TO_DOT = "Let dot decide";

// Your answer as it reads in the thread: the value alone for one field, otherwise a line per
// field answered. A secret is never shown, only that it was given.
export function answerSummary(question: AgentQuestion): string {
  const answer = question.answer;
  if (!answer) return "";
  if (answer.declined) return question.decline ?? "Not now";
  if (!question.fields?.length || !answer.fields) {
    const chosen = question.options.find((option) => option.key === answer.option);
    return [chosen?.text ?? answer.option, answer.text].filter(Boolean).join("\n\n");
  }
  const given = answer.fields;
  const shown = question.fields.flatMap((field) => {
    const value = given[field.id];
    if (value === undefined) return [];
    const text = Array.isArray(value)
      ? value.join(", ")
      : isOwnWords(value)
        ? [...(value.selected ?? []), value.other].join(", ")
        : typeof value === "object"
          ? SECRET_SHOWN
          : value === true
            ? field.kind === "qr"
              ? "Done"
              : (question.submit ?? "Yes")
            : field.kind === "file"
              ? (value.split("/").at(-1) ?? value)
              : value;
    return [{ label: field.label, text }];
  });
  if (!shown.length) return answer.skipped?.length ? LEFT_TO_DOT : "";
  if (question.fields.length === 1 && shown[0]?.text !== SECRET_SHOWN) return shown[0]?.text ?? "";
  return shown.map(({ label, text }) => `${label}: ${text}`).join("\n");
}
