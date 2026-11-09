import type { AskUserInput } from "@localdot/protocol";

// Reads what dot wrote for a form, so that it can't stand in for localDot's own card or take a secret
// in plain text. A word list is a mitigation and no guarantee: a paraphrase, another language or a
// picture of the words gets past it. What holds regardless is that the passphrase field is only ever
// on localDot's card, which goes straight to the key service, and that dot's forms say so.

const LOOKALIKES = new Map(
  [..."аеорсухіѕјһԁАВЕКМНОРСТХαορικυνΑΕΚΜΟΡΤօսոհցɑɡıɩ"].map((letter, at) => [
    letter,
    "aeopcyxisjhdABEKMHOPCTXaopikuvAEKMOPTounhgagii"[at] ?? letter,
  ]),
);
// Digits and signs written for letters, read as letters inside a word that has letters: pa55w0rd.
const LEET: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
};

export function plainWords(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/(\p{Script=Latin})\p{Mn}+/gu, "$1")
    .normalize("NFKC")
    .replace(/./gsu, (letter) => LOOKALIKES.get(letter) ?? letter)
    .replace(/\p{Pd}/gu, "-")
    .replace(/[\p{L}\p{N}@$]+/gu, (word) =>
      /\p{L}/u.test(word) ? word.replace(/[013457@$]/g, (sign) => LEET[sign] ?? sign) : word,
    )
    .replace(/\s+/gu, " ")
    .trim();
}

const LOCALDOT = /\blocal[\s_.-]*dot\b/iu;
const VAULT =
  /\bvaults?\b|\bkeychains?\b|\bboveda\b|\bcoffre(?:-fort)?\b|\btrousseau\b|保险库|保險庫|密钥库|密鑰庫|金鑰庫/iu;
const AIMED_AT_KEYS = new RegExp(
  `${LOCALDOT.source}|${VAULT.source}|\\bsaved[\\s_-]+(?:keys?|passwords?)\\b|\\b(?:claves|llaves|contrasenas) guardadas\\b|\\bcles (?:enregistrees|sauvegardees)\\b|保存的密钥|保存的密鑰|已保存.{0,4}密钥|已儲存.{0,4}金鑰`,
  "iu",
);
// Its name in the app is capitalized, and other people's keys get locked in cars.
const KEYS_PAGE = /\bKeys\b|\bKEYS\b/u;
const UNLOCKING =
  /\bunlock\w*|\b(?:re)?locked\b|\bpass[\s_-]*phrase|\b(?:master|vault)[\s_-]+(?:pass[\s_-]*word|key)|\bdesbloque\w*|\bbloquead[oa]s?\b|\bdeverrouill\w*|\bverrouill\w*|解锁|解鎖|锁定|鎖定|口令|密码短语|密碼短語|主密码|主密碼/iu;
const ITS_SECRET =
  /passphrase|masterpassword|vaultpassword|masterkey|vaultkey|frasedecontrasena|frasesecreta|contrasenamaestra|phrasesecrete|phrasedepasse|motdepasseprincipal/u;
const ITS_SECRET_ZH = /口令|密码短语|密碼短語|主密码|主密碼|解锁密码|解鎖密碼/u;

// Words apart or marked up still spell it.
const squeezed = (words: string) => words.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export const claimsLocalDot = (words: string) =>
  LOCALDOT.test(words) ||
  /\bkey[\s_-]*service\b/iu.test(words) ||
  squeezed(words).includes("ocaldot");
export const namesItsSecret = (words: string) =>
  ITS_SECRET.test(squeezed(words)) || ITS_SECRET_ZH.test(words);

// What only asks about one ("Reset your password?") isn't asking for it.
const ABOUT = String.raw`(?!\s+(?:managers?|hints?|polic(?:y|ies)|resets?|rules?|length|requirements?|strength|expir\w*|changes?|recovery))`;
const A_SECRET = [
  String.raw`\bpass[\s_-]*(?:word|code|phrase)s?\b${ABOUT}`,
  String.raw`\bpwd\b`,
  String.raw`\bpins?\b`,
  String.raw`\b(?:client|app|webhook|shared|signing|api|account)[\s_-]+secrets?\b`,
  String.raw`\bsecret[\s_-]+(?:keys?|tokens?|codes?|values?|phrases?)\b`,
  String.raw`\bapi[\s_-]*keys?\b`,
  String.raw`\b(?:access|auth|bearer|refresh)[\s_-]*tokens?\b`,
  String.raw`\bprivate[\s_-]+keys?\b`,
  String.raw`\b(?:recovery|seed)[\s_-]+(?:code|phrase)s?\b`,
  String.raw`\bcv[vc]\b`,
  String.raw`\bsecurity[\s_-]+code\b`,
  String.raw`\bcontrasenas?\b${ABOUT}`,
  String.raw`\bclave secreta\b`,
  String.raw`\bcodigo pin\b`,
  String.raw`\bmots? de passe\b${ABOUT}`,
  String.raw`\bphrase secrete\b`,
  String.raw`\bcode (?:secret|pin)\b`,
  "密码|密碼|口令|密钥|密鑰|金鑰|パスワード",
].join("|");
const NAMES_A_SECRET = new RegExp(A_SECRET, "iu");
// "Not an API key or client secret" names what the answer isn't. Only the secrets the denial itself
// lists are passed over: "not your PIN but your password" still names the password.
const ARTICLE = String.raw`(?:(?:an?|the|your|any)\s+)?`;
const DENIED = new RegExp(
  String.raw`\b(?:not|never|no|nor)\s+${ARTICLE}(?:${A_SECRET})(?:\s*(?:,|\bor\b|\bnor\b)\s*${ARTICLE}(?:${A_SECRET}))*`,
  "giu",
);
const affirmed = (words: string) => plainWords(words).replace(DENIED, " ");
const ASKS_FOR_A_SECRET = new RegExp(
  [
    String.raw`\b(?:enter|type|provide|give|send|share|paste|input|supply|tell\s+me|what(?:'s|\s+is)|need|introduce|escribe|ingresa|indica|saisis\w*|entre[rz]?|tape[rz]?|donne[rz]?)\b[^?!\n]{0,60}(?:${A_SECRET})`,
    // Just the thing itself, "Password for example.com?" or "Your PIN?", not "Pin this note?"
    String.raw`^(?:(?:your|the|my|tu|su|votre|ton)\s+)?(?:[\p{L}.-]+\s+)?(?:${A_SECRET})\s*(?:$|[?:.]|\s+(?:for|of|on|at|please|por|para|de|du|pour)\b)`,
    String.raw`(?:输入|輸入|提供|告诉|告訴|填写|填寫)[^。？！\n]{0,20}(?:密码|密碼|口令|密钥|密鑰|金鑰)`,
  ].join("|"),
  "iu",
);
// Fields whose answer is the user's own words: a choice's Other takes them too.
const OWN_WORDS: ReadonlySet<string> = new Set([
  "text",
  "longtext",
  "email",
  "url",
  "phone",
  "number",
  "date",
  "choice",
  "multichoice",
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

// Words about unlocking localDot's keys or asking for their passphrase, or a secret named beside a
// vault: these are the Unlock card's to ask for.
export const aimsAtKeys = (words: string) =>
  (VAULT.test(words) && NAMES_A_SECRET.test(words)) ||
  ((AIMED_AT_KEYS.test(words) || KEYS_PAGE.test(words)) &&
    (UNLOCKING.test(words) || namesItsSecret(words)));

// A plain answer lands in the conversation, the log and the model's context.
export function asksSecretInPlainText(input: AskUserInput): boolean {
  const fields = input.fields ?? [];
  const named = (words: string) =>
    NAMES_A_SECRET.test(affirmed(words)) || /\bsecrets?\b/iu.test(affirmed(words));
  if (
    fields.some(
      (f) => OWN_WORDS.has(f.kind) && named(`${fieldWords(f.id)}\n${f.label}\n${f.hint ?? ""}`),
    )
  )
    return true;
  const typedPrivately = fields.some((f) => f.kind === "secret" || f.kind === "code");
  // A question with options or nothing to fill in is answered in the user's own words too.
  const answeredInWords = !fields.length || fields.some((f) => OWN_WORDS.has(f.kind));
  return !typedPrivately && answeredInWords && ASKS_FOR_A_SECRET.test(affirmed(input.question));
}
