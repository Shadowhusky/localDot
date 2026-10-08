import { type AutonomyPolicy, DEFAULT_AUTONOMY, type Target, ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { redactor } from "../redact.ts";
import { AgentSession } from "../session.ts";
import type { ToolCallContext } from "../tools/deps.ts";
import { authorizePrepared } from "./authorize.ts";
import { nativeActionFacts } from "./classify.ts";

const SECRET = "synthetic-known-secret-0123";

function harness(policy: AutonomyPolicy = DEFAULT_AUTONOMY) {
  const session = new AgentSession(ulid(), ulid(), "task", { append: vi.fn() }, policy);
  vi.spyOn(session, "requestApproval").mockResolvedValue("approve");
  const takeover = vi.spyOn(session, "takeover").mockResolvedValue({ by: "user" });
  const signal = new AbortController().signal;
  const ctx = {
    session,
    generation: { id: 1, signal },
    lease: { generation: { id: 1, signal }, signal, check() {}, finish() {} },
    check() {},
    callId: ulid(),
    step: ulid(),
    redact: redactor([SECRET]),
    signal,
  } as unknown as ToolCallContext;
  return { ctx, takeover };
}

function field(name: string, extra: Partial<Target> = {}): Target {
  return {
    point: { x: 4, y: 4 },
    source: "dom",
    role: "textbox",
    name,
    url: "https://account.example.test/",
    ...extra,
  };
}

async function handOff(
  target: Target,
  text = "abc",
  policy?: AutonomyPolicy,
  verb: "type" | "click" = "type",
) {
  const h = harness(policy);
  const action =
    verb === "type"
      ? { verb, text, speed: "auto" as const }
      : { verb, point: target.point, speed: "auto" as const };
  const permit = await authorizePrepared(h.ctx, {
    tool: "computer",
    input: { action },
    target: { target, window: 1, point: target.point },
    facts: nativeActionFacts(action, target),
    revalidate: async () => true,
  });
  expect(permit).toBeUndefined();
  expect(h.takeover).toHaveBeenCalledOnce();
  const [reason, note] = h.takeover.mock.calls[0] ?? [];
  return { reason, note };
}

const PASSWORD = "This field takes a password. Type it on the computer, then hand control back.";
const SIGN_IN = "This is a sign-in field. Fill it in on the computer, then hand control back.";
const CODE = "This field takes a one-time code. Type it on the computer, then hand control back.";
const CAPTCHA = "This is a CAPTCHA. Solve it on the computer, then hand control back.";
const PAYMENT =
  "This field takes card or payment details. Type them on the computer, then hand control back.";

describe("why a step is handed to the user", () => {
  it.each([
    ["a password field", field("Password"), "login", PASSWORD],
    [
      "a field the page marks secret",
      field("Protected field", { secret: true }),
      "login",
      PASSWORD,
    ],
    [
      "a secure text field",
      field("", { source: "ax", role: "AXSecureTextField" }),
      "login",
      PASSWORD,
    ],
    ["a sign-in password", field("Sign-in password"), "login", PASSWORD],
    ["a sign-in email", field("Sign in email"), "login", SIGN_IN],
    ["a 登录 field", field("登录账号"), "login", SIGN_IN],
    ["a one-time code", field("One-time code"), "2fa", CODE],
    ["a one-time passcode", field("One-time passcode", { secret: true }), "2fa", CODE],
    ["a verification code", field("Verification code"), "2fa", CODE],
    ["a 验证码 field", field("短信验证码"), "2fa", CODE],
    ["a CAPTCHA", field("Type the CAPTCHA text"), "captcha", CAPTCHA],
    ["a card number", field("Card number"), "payment", PAYMENT],
    ["a CVV", field("CVV", { secret: true }), "payment", PAYMENT],
    ["a card security code", field("Security code"), "payment", PAYMENT],
    ["a billing address", field("Billing address"), "payment", PAYMENT],
    ["a payment field", field("Payment details"), "payment", PAYMENT],
  ] as const)("%s", async (_name, target, reason, note) => {
    expect(await handOff(target)).toEqual({ reason, note });
  });

  it("clicking into a password field says the same as typing into it", async () => {
    expect(await handOff(field("Password"), undefined, undefined, "click")).toEqual({
      reason: "login",
      note: PASSWORD,
    });
  });

  it("names the class the user chose to do themselves", async () => {
    const send = field("Send", { role: "button", url: "https://mail.example.test/compose" });
    expect(
      await handOff(send, undefined, { ...DEFAULT_AUTONOMY, send: "handoff" }, "click"),
    ).toEqual({
      reason: "other",
      note: "You chose to do this yourself: Send as you. Do it on the computer, then hand control back.",
    });
  });

  it("a user-chosen class names its own label, not the computer's", async () => {
    const notes: Target = {
      point: { x: 4, y: 4 },
      source: "ax",
      role: "AXTextArea",
      name: "Notes",
      app: "Editor",
    };
    expect(await handOff(notes, "draft", { ...DEFAULT_AUTONOMY, computer: "handoff" })).toEqual({
      reason: "other",
      note: "You chose to do this yourself: Work in its computer. Do it on the computer, then hand control back.",
    });
  });

  it("a private localDot key in the input is never typed by the agent", async () => {
    expect(await handOff(field("Notes"), `token ${SECRET}`)).toEqual({
      reason: "other",
      note: "This step contains a private localDot key, so it won't run on its own. Do it on the computer if you need to, then hand control back.",
    });
  });

  it("a password field wins over a known key in the same step", async () => {
    expect(await handOff(field("Password"), SECRET)).toEqual({
      reason: "login",
      note: PASSWORD,
    });
  });
});
