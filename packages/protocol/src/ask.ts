import { z } from "zod";

// The kinds of answer field dot can ask for (HITL.md §3). A `secret` answer is typed into the
// computer by the daemon and never reaches the model or conversation stores. Verified browser
// sign-ins may be retained in keyd's protected credential store for reuse on the same origin.
export const ASK_FIELD_KINDS = [
  "text",
  "longtext",
  "secret",
  "code",
  "choice",
  "multichoice",
  "confirm",
  "number",
  "date",
  "email",
  "url",
  "phone",
  "file",
  "qr",
] as const;
export const AskFieldKind = z.enum(ASK_FIELD_KINDS);
export type AskFieldKind = z.infer<typeof AskFieldKind>;

export const MAX_ASK_FIELDS = 4;
export const ASK_FIELD_ID = /^[a-z][a-z0-9_]{0,31}$/;
export const AskFieldId = z.string().regex(ASK_FIELD_ID);

// One field's answer: text for most kinds, the picked options for multichoice, true for confirm
// and for a QR code the user dealt with.
export const AskFieldValue = z.union([
  z.string().max(8000),
  z.array(z.string().min(1).max(200)).max(6),
  z.literal(true),
]);
export type AskFieldValue = z.infer<typeof AskFieldValue>;

// What the journal keeps of a field's answer: a secret only as provided.
export const AskFieldRecord = z.union([
  AskFieldValue,
  z.strictObject({ provided: z.literal(true) }),
]);
export type AskFieldRecord = z.infer<typeof AskFieldRecord>;

export interface AskFieldRule {
  readonly kind: AskFieldKind;
  readonly options?: readonly string[];
  readonly length?: number;
}

const TEXT_LIMIT: Partial<Record<AskFieldKind, number>> = {
  longtext: 8000,
  secret: 1000,
  code: 32,
  url: 2048,
  file: 1024,
};
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{3,32}$/;

function webAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Desktop paths an upload placed in the computer's home.
function homePath(value: string): boolean {
  return (
    value.startsWith("~/") &&
    value
      .slice(2)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

// Why `value` cannot answer `field`, in words for the person answering; undefined when it can.
// The answer card checks as the person types and the daemon checks again on arrival.
export function askValueProblem(
  field: AskFieldRule,
  value: string | true | readonly string[] | undefined,
): string | undefined {
  switch (field.kind) {
    case "confirm":
      return value === true ? undefined : "Confirm to continue";
    case "qr":
      return value === undefined || value === true ? undefined : "Nothing to fill in here";
    case "multichoice":
      return Array.isArray(value) &&
        new Set(value).size === value.length &&
        value.every((pick) => field.options?.includes(pick))
        ? undefined
        : "Pick from the list";
  }
  if (typeof value !== "string" || !value.trim())
    return field.kind === "choice"
      ? "Pick one"
      : field.kind === "file"
        ? "Choose a file"
        : "Fill this in";
  const limit = TEXT_LIMIT[field.kind] ?? 2000;
  if (value.length > limit) return `Keep it under ${limit} characters`;
  if (!value.isWellFormed() || value.includes("\0")) return "Remove the unusual characters";
  if (field.kind !== "longtext" && CONTROL.test(value)) return "Keep it on one line";
  const text = value.trim();
  switch (field.kind) {
    case "code":
      return field.length && [...text].length !== field.length
        ? `Enter all ${field.length} characters`
        : undefined;
    case "number":
      return Number.isFinite(Number(text)) ? undefined : "Enter a number";
    case "date":
      return DATE.test(text) ? undefined : "Enter a date as YYYY-MM-DD";
    case "email":
      return EMAIL.test(text) ? undefined : "Enter an email address";
    case "url":
      return webAddress(text) ? undefined : "Enter a web address starting with https://";
    case "phone":
      return PHONE.test(text) ? undefined : "Enter a phone number";
    case "file":
      return homePath(value) ? undefined : "Choose a file";
  }
  return undefined;
}
