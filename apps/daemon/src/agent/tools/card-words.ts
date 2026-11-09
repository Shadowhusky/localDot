import type { AskUserInput } from "@localdot/protocol";

// Reads what dot wrote for a form, so that it can't stand in for localDot's own card or take a secret
// in plain text. A word list is a mitigation and no guarantee: a paraphrase, another language or a
// picture of the words gets past it. What holds regardless is that the passphrase field is only ever
// on localDot's card, which goes straight to the key service, and that dot's forms say so.

const LOOKALIKES = new Map(
  [..."аеорсухіѕјһԁАВЕКМНОРСТХαορικυΑΕΚΜΟΡΤ"].map((letter, at) => [
    letter,
    "aeopcyxisjhdABEKMHOPCTXaopikuAEKMOPT"[at] ?? letter,
  ]),
);

export function plainWords(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/(\p{Script=Latin})\p{Mn}+/gu, "$1")
    .normalize("NFKC")
    .replace(/./gsu, (letter) => LOOKALIKES.get(letter) ?? letter)
    .replace(/\s+/gu, " ")
    .trim();
}

const LOCALDOT = /\blocal[\s_.-]*dot\b/iu;
const AIMED_AT_KEYS = new RegExp(
  `${LOCALDOT.source}|\\bsaved[\\s_-]+(?:keys?|passwords?)\\b|\\bvaults?\\b|\\bkeychain\\b|保险库|保險庫|密钥库|密鑰庫|金鑰庫|保存的密钥|保存的密鑰|已保存.{0,4}密钥|已儲存.{0,4}金鑰`,
  "iu",
);
// Its name in the app is capitalized, and other people's keys get locked in cars.
const KEYS_PAGE = /\bKeys\b|\bKEYS\b/u;
const UNLOCKING =
  /\bunlock\w*|\b(?:re)?locked\b|\bpass[\s_-]*phrase|\b(?:master|vault)[\s_-]+(?:pass[\s_-]*word|key)|解锁|解鎖|锁定|鎖定|口令|密码短语|密碼短語|主密码|主密碼/iu;
const ITS_SECRET = /passphrase|masterpassword|vaultpassword|masterkey|vaultkey/u;
const ITS_SECRET_ZH = /口令|密码短语|密碼短語|主密码|主密碼|解锁密码|解鎖密碼/u;

// Words apart or marked up still spell it.
const squeezed = (words: string) => words.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export const claimsLocalDot = (words: string) =>
  LOCALDOT.test(words) || squeezed(words).includes("localdot");
export const namesItsSecret = (words: string) =>
  ITS_SECRET.test(squeezed(words)) || ITS_SECRET_ZH.test(words);
// Words that would send the user to Keys, or ask for what only Keys may take.
export const aimsAtKeys = (words: string) =>
  (AIMED_AT_KEYS.test(words) || KEYS_PAGE.test(words)) &&
  (UNLOCKING.test(words) || namesItsSecret(words));

const A_SECRET =
  "\\bpass[\\s_-]*(?:word|code|phrase)s?\\b(?!\\s+(?:manager|hint|policy|reset|rules?|length|requirements?))|\\bpwd\\b|\\bpin\\b|\\bsecrets?\\b|\\bapi[\\s_-]*keys?\\b|\\b(?:access|auth|bearer|refresh)[\\s_-]*tokens?\\b|\\bprivate[\\s_-]+keys?\\b|\\b(?:recovery|seed)[\\s_-]+(?:code|phrase)s?\\b|\\bcv[vc]\\b|\\bsecurity[\\s_-]+code\\b|密码|密碼|口令|密钥|密鑰|金鑰|パスワード";
const NAMES_A_SECRET = new RegExp(A_SECRET, "iu");
const ASKS_FOR_A_SECRET = new RegExp(
  `\\b(?:enter|type|provide|give|send|share|paste|input|supply|tell\\s+me|what(?:'s|\\s+is)|need)\\b[^?!\\n]{0,60}(?:${A_SECRET})|(?:输入|輸入|提供|告诉|告訴|填写|填寫)[^。？！\\n]{0,20}(?:密码|密碼|口令|密钥|密鑰|金鑰)`,
  "iu",
);
const PLAIN_KINDS: ReadonlySet<string> = new Set([
  "text",
  "longtext",
  "email",
  "url",
  "phone",
  "number",
  "date",
]);
export const fieldWords = (id: string) => id.replaceAll("_", " ");

// Everything a form puts in front of the user.
export function formWords(input: AskUserInput): string {
  return plainWords(
    [
      input.question,
      ...(input.options ?? []),
      input.submit ?? "",
      input.decline ?? "",
      ...(input.fields ?? []).flatMap((field) => [
        fieldWords(field.id),
        field.label,
        field.hint ?? "",
        field.value ?? "",
        ...(field.options ?? []),
      ]),
    ].join("\n"),
  );
}

// A plain answer lands in the conversation, the log and the model's context.
export function asksSecretInPlainText(input: AskUserInput): boolean {
  const fields = input.fields ?? [];
  if (fields.some((f) => PLAIN_KINDS.has(f.kind) && named(`${fieldWords(f.id)}\n${f.label}`)))
    return true;
  const typedPrivately = fields.some((f) => f.kind === "secret" || f.kind === "code");
  const answeredInWords = fields.length
    ? fields.some((f) => PLAIN_KINDS.has(f.kind))
    : !input.options;
  return !typedPrivately && answeredInWords && ASKS_FOR_A_SECRET.test(plainWords(input.question));
}
const named = (words: string) => NAMES_A_SECRET.test(plainWords(words));
