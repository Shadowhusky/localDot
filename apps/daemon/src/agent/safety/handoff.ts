import { ACTION_CLASS_LABELS, type RequestTakeoverInput } from "@localdot/protocol";
import type { RiskDecision, RiskFacts } from "./risk.ts";

export interface Handoff {
  readonly reason: RequestTakeoverInput["reason"];
  readonly note: string;
}

const BACK = "on the computer, then hand control back.";
const PASSWORD: Handoff = {
  reason: "login",
  note: `This field takes a password. Type it ${BACK}`,
};

// First match wins: a "one-time passcode" is a code, and a "sign-in password" or a "billing
// password" a password.
const FIELDS: readonly (readonly [RegExp, Handoff])[] = [
  [
    /one[ -]?time|verification[ -]?code|2fa|two[ -]?(?:factor|step)|authenticat(?:ion|or) code|\botp\b|验证码|驗證碼/i,
    { reason: "2fa", note: `This field takes a one-time code. Type it ${BACK}` },
  ],
  [/captcha/i, { reason: "captcha", note: `This is a CAPTCHA. Solve it ${BACK}` }],
  [/password|passphrase|passcode|密碼|密码/i, PASSWORD],
  [
    /credit[ -]?card|card[ -]?number|security[ -]?code|cvv|cvc|expiry|expiration|billing|payment|支付|付款|信用卡/i,
    { reason: "payment", note: `This field takes card or payment details. Type them ${BACK}` },
  ],
  [
    /sign[ -]?in|log[ -]?in|登入|登录|登錄/i,
    { reason: "login", note: `This is a sign-in field. Fill it in ${BACK}` },
  ],
];

// Any other hand-off comes from the known-secret check on the step's input, target or preview.
export function handoffFor(decision: RiskDecision, facts: RiskFacts): Handoff {
  if (decision.actionClass === "credentials") {
    const name = facts.target?.name ?? "";
    return FIELDS.find(([pattern]) => pattern.test(name))?.[1] ?? PASSWORD;
  }
  if (decision.mode === "handoff")
    return {
      reason: "other",
      note: `You chose to do this yourself: ${ACTION_CLASS_LABELS[decision.actionClass]}. Do it ${BACK}`,
    };
  return {
    reason: "other",
    note: "This step included one of localDot's private keys, so it didn't run. Hand control back to continue.",
  };
}
