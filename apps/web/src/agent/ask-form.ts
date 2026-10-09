import {
  type AskFieldKind,
  type AskFieldValue,
  askValueProblem,
  type QuestionAnswerRequest,
} from "@localdot/protocol";
import type { AgentQuestion } from "./model.ts";

// One field of a question as every surface draws it. A plain question (lettered options and/or
// free text) becomes one field of its own, so the thread, the island and the sheet share controls.
export interface AskField {
  readonly id: string;
  readonly kind: AskFieldKind;
  readonly label: string;
  readonly hint?: string;
  readonly options: readonly string[];
  // A choice's last row takes free text ("Something else…").
  readonly other: boolean;
  // A code's cell count.
  readonly length: number;
  // What a QR code holds.
  readonly value?: string;
  // A secret's site: whose page the field it is typed into is on.
  readonly site?: string;
}

// What a field holds while it is filled in. A choice holds the picked option's index as text, or
// OTHER once its "Something else…" row has text.
export type DraftValue = string | readonly string[] | boolean;
export interface Draft {
  readonly values: Readonly<Record<string, DraftValue>>;
  readonly other: Readonly<Record<string, string>>;
}

export const OTHER = "other";
export const CODE_LENGTH = 6;
const PLAIN = "answer";
const FREE_TEXT = new Set<AskFieldKind>([
  "text",
  "longtext",
  "number",
  "date",
  "email",
  "url",
  "phone",
  "code",
  "choice",
]);

export function askFields(question: AgentQuestion): readonly AskField[] {
  if (question.fields?.length)
    return question.fields.map((field) => ({
      id: field.id,
      kind: field.kind,
      label: field.label,
      ...(field.hint ? { hint: field.hint } : {}),
      options: field.options ?? [],
      other: field.kind === "choice",
      length: field.length ?? CODE_LENGTH,
      ...(field.value ? { value: field.value } : {}),
      ...(field.target?.site ? { site: field.target.site } : {}),
    }));
  return [
    {
      id: PLAIN,
      kind: question.options.length ? "choice" : "longtext",
      label: "Your answer",
      options: question.options.map((option) => option.text),
      other: question.options.length > 0 && question.allowText,
      length: CODE_LENGTH,
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

// The value a field answers with, or undefined while it has none.
export function fieldValue(
  field: AskField,
  draft: Draft,
  fields: readonly AskField[] = [field],
): AskFieldValue | undefined {
  const value = draft.values[field.id];
  switch (field.kind) {
    case "qr":
      return true;
    case "confirm":
      return value === true || confirmsBySubmit(fields) ? true : undefined;
    case "multichoice":
      return Array.isArray(value) ? value : undefined;
    case "choice": {
      if (value === OTHER) return draft.other[field.id]?.trim() || undefined;
      const picked = typeof value === "string" && value ? field.options[Number(value)] : undefined;
      return picked;
    }
    case "secret":
      return typeof value === "string" && value ? value : undefined;
    default:
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
}

// Why a field can't be sent yet, in the card's words; undefined once it can.
export function fieldProblem(
  field: AskField,
  draft: Draft,
  fields: readonly AskField[] = [field],
): string | undefined {
  const value = fieldValue(field, draft, fields);
  return askValueProblem(field, value);
}

// What Send says while the answer is incomplete: the first field that needs something.
export function submitProblem(fields: readonly AskField[], draft: Draft): string | undefined {
  for (const field of fields) {
    const problem = fieldProblem(field, draft, fields);
    if (!problem) continue;
    if (fieldValue(field, draft, fields) === undefined)
      return field.kind === "choice" || field.kind === "file"
        ? `Choose ${lower(field.label)} first`
        : field.kind === "confirm"
          ? `Tick ${lower(field.label)} first`
          : `Fill in ${lower(field.label)} first`;
    return `${field.label}: ${problem}`;
  }
  return undefined;
}

const lower = (label: string) =>
  /^[A-Z][a-z]/.test(label) ? label[0]?.toLowerCase() + label.slice(1) : label;

// The request that answers the question from the draft, once every field can be sent.
export function answerRequest(
  question: AgentQuestion,
  fields: readonly AskField[],
  draft: Draft,
): QuestionAnswerRequest | undefined {
  if (submitProblem(fields, draft)) return undefined;
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
// can be the whole answer; otherwise turn the question down so dot reads the message, and any files
// with it, at once. A question with a secret holds the message, which would reach dot in plain
// text, and so does one that can only be answered.
export type ComposerReply =
  | { readonly kind: "answer"; readonly request: QuestionAnswerRequest }
  | { readonly kind: "decline"; readonly request: QuestionAnswerRequest }
  | { readonly kind: "hold"; readonly reason: string };

export function composerReply(
  question: AgentQuestion,
  text: string,
  attached = false,
): ComposerReply {
  if (question.fields?.some((field) => field.kind === "secret"))
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
  if (question.fields.length !== 1 || !field || !FREE_TEXT.has(field.kind)) return decline;
  const value =
    field.kind === "choice"
      ? (field.options.find((option) => option.toLowerCase() === said.toLowerCase()) ?? said)
      : said;
  return askValueProblem(field, value)
    ? decline
    : { kind: "answer", request: { askId: question.askId, fields: { [field.id]: value } } };
}

const SECRET_SHOWN = "kept secret";

// Your answer as it reads in the thread: the value alone for one field, otherwise a line per
// field. A secret is never shown, only that it was given.
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
    const text =
      typeof value === "object" && !Array.isArray(value)
        ? SECRET_SHOWN
        : Array.isArray(value)
          ? value.join(", ")
          : value === true
            ? field.kind === "qr"
              ? "Done"
              : (question.submit ?? "Yes")
            : field.kind === "file"
              ? (value.split("/").at(-1) ?? value)
              : value;
    return [{ label: field.label, text }];
  });
  if (shown.length === 1 && shown[0]?.text !== SECRET_SHOWN) return shown[0]?.text ?? "";
  return shown.map(({ label, text }) => `${label}: ${text}`).join("\n");
}
