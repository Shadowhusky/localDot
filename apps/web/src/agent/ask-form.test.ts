import { describe, expect, it } from "vitest";
import {
  answerRequest,
  answerSummary,
  askFields,
  composerReply,
  type Draft,
  emptyDraft,
  fieldValue,
  OTHER,
  submitProblem,
} from "./ask-form.ts";
import type { AgentQuestion } from "./model.ts";

const ASK = "01JXYZ00000000000000000001";
const login: AgentQuestion = {
  askId: ASK,
  question: "Sign in to the bank.",
  options: [],
  allowText: false,
  fields: [
    { id: "email", kind: "email", label: "Email" },
    { id: "password", kind: "secret", label: "Password" },
  ],
  submit: "Sign in",
};
const plain: AgentQuestion = {
  askId: ASK,
  question: "Which format?",
  options: [
    { key: "A", text: "Markdown" },
    { key: "B", text: "PDF" },
  ],
  allowText: true,
};
const draft = (values: Draft["values"], other: Draft["other"] = {}): Draft => ({ values, other });

describe("askFields", () => {
  it("draws a plain question as one choice, with Something else only when it takes text", () => {
    expect(askFields(plain)).toEqual([
      expect.objectContaining({ kind: "choice", options: ["Markdown", "PDF"], other: true }),
    ]);
    expect(askFields({ ...plain, allowText: false })[0]?.other).toBe(false);
    expect(askFields({ ...plain, options: [] })[0]?.kind).toBe("longtext");
  });

  it("gives a code six cells unless dot says how many", () => {
    const code = (length?: number): AgentQuestion => ({
      ...login,
      fields: [{ id: "code", kind: "code", label: "Code", ...(length ? { length } : {}) }],
    });
    expect(askFields(code())[0]?.length).toBe(6);
    expect(askFields(code(8))[0]?.length).toBe(8);
  });
});

describe("answers", () => {
  const fields = askFields(login);

  it("sends each field by id, the secret exactly as typed", () => {
    expect(
      answerRequest(login, fields, draft({ email: "  henry@example.test ", password: " pa ss " })),
    ).toEqual({ askId: ASK, fields: { email: "henry@example.test", password: " pa ss " } });
  });

  it("says what is missing or wrong, and sends nothing until it is fixed", () => {
    expect(submitProblem(fields, emptyDraft(fields))).toBe("Fill in email first");
    expect(submitProblem(fields, draft({ email: "henry", password: "x" }))).toBe(
      "Email: Enter an email address",
    );
    expect(submitProblem(fields, draft({ email: "henry@example.test", password: "" }))).toBe(
      "Fill in password first",
    );
    expect(answerRequest(login, fields, draft({ email: "henry", password: "x" }))).toBeUndefined();
    const file = askFields({ ...login, fields: [{ id: "photo", kind: "file", label: "Photo" }] });
    expect(submitProblem(file, emptyDraft(file))).toBe("Choose photo first");
  });

  it("answers a plain question with the option's letter, or with the text written", () => {
    const one = askFields(plain);
    expect(answerRequest(plain, one, draft({ answer: "1" }))).toEqual({ askId: ASK, option: "B" });
    expect(answerRequest(plain, one, draft({ answer: OTHER }, { answer: " Both " }))).toEqual({
      askId: ASK,
      text: "Both",
    });
    expect(answerRequest(plain, one, draft({ answer: "" }))).toBeUndefined();
  });

  it("takes a lone confirm from the submit button, and a QR code as dealt with", () => {
    const confirm: AgentQuestion = {
      ...login,
      fields: [{ id: "sure", kind: "confirm", label: "Delete 12 drafts" }],
    };
    expect(answerRequest(confirm, askFields(confirm), draft({ sure: false }))).toEqual({
      askId: ASK,
      fields: { sure: true },
    });
    const mixed: AgentQuestion = {
      ...login,
      fields: [
        { id: "name", kind: "text", label: "Name" },
        { id: "sure", kind: "confirm", label: "I agree" },
      ],
    };
    const both = askFields(mixed);
    expect(submitProblem(both, draft({ name: "Sam", sure: false }))).toBe("Tick I agree first");
    const qr: AgentQuestion = {
      ...login,
      fields: [{ id: "pair", kind: "qr", label: "Link", value: "https://pair.example.test/a" }],
    };
    expect(answerRequest(qr, askFields(qr), emptyDraft(askFields(qr)))).toEqual({
      askId: ASK,
      fields: { pair: true },
    });
  });

  it("keeps multichoice picks and a choice's own words", () => {
    const pick: AgentQuestion = {
      ...login,
      fields: [
        { id: "parts", kind: "multichoice", label: "Include", options: ["Totals", "Charts"] },
        { id: "tone", kind: "choice", label: "Tone", options: ["Formal"] },
      ],
    };
    const both = askFields(pick);
    const values = draft({ parts: ["Charts"], tone: OTHER }, { tone: "Warm" });
    expect(fieldValue(both[1] as (typeof both)[number], values)).toBe("Warm");
    expect(answerRequest(pick, both, values)).toEqual({
      askId: ASK,
      fields: { parts: ["Charts"], tone: "Warm" },
    });
  });
});

describe("composerReply", () => {
  it("answers a plain question with the message, or the option it names", () => {
    expect(composerReply(plain, " pdf ")).toEqual({
      kind: "answer",
      request: { askId: ASK, option: "B" },
    });
    expect(composerReply(plain, "Both, please")).toEqual({
      kind: "answer",
      request: { askId: ASK, text: "Both, please" },
    });
    expect(composerReply({ ...plain, allowText: false }, "Both").kind).toBe("decline");
  });

  it("holds a message while a secret is asked for, so a password never goes as text", () => {
    expect(composerReply(login, "hunter2").kind).toBe("hold");
  });

  it("fills a lone field it fits, and otherwise turns the question down", () => {
    const one: AgentQuestion = {
      ...login,
      fields: [{ id: "reply", kind: "longtext", label: "Reply" }],
    };
    expect(composerReply(one, "Thanks, see you Friday")).toEqual({
      kind: "answer",
      request: { askId: ASK, fields: { reply: "Thanks, see you Friday" } },
    });
    const mail: AgentQuestion = {
      ...login,
      fields: [{ id: "to", kind: "email", label: "To" }],
    };
    expect(composerReply(mail, "use my work account").kind).toBe("decline");
    const two: AgentQuestion = {
      ...login,
      fields: [
        { id: "a", kind: "text", label: "A" },
        { id: "b", kind: "text", label: "B" },
      ],
    };
    expect(composerReply(two, "a").kind).toBe("decline");
  });

  it("turns the question down for a message with files, so dot reads both at once", () => {
    expect(composerReply(plain, "PDF", true)).toEqual({
      kind: "decline",
      request: { askId: ASK, declined: true },
    });
    expect(composerReply(login, "here it is", true).kind).toBe("hold");
  });

  it("holds what can't answer a question that has no way out", () => {
    const only: AgentQuestion = { ...plain, allowText: false, declinable: false };
    expect(composerReply(only, "PDF")).toEqual({
      kind: "answer",
      request: { askId: ASK, option: "B" },
    });
    expect(composerReply(only, "something else")).toEqual({
      kind: "hold",
      reason: "Answer dot's question above first. Your message stays here.",
    });
    expect(composerReply({ ...plain, declinable: false }, "Try the menu", true).kind).toBe("hold");
  });
});

describe("answerSummary", () => {
  it("never shows a secret, only that it was given", () => {
    const answered: AgentQuestion = {
      ...login,
      answer: {
        askId: ASK,
        by: "user",
        fields: { email: "henry@example.test", password: { provided: true } },
      },
    };
    expect(answerSummary(answered)).toBe("Email: henry@example.test\nPassword: kept secret");
  });

  it("shows a lone answer alone, and a decline in dot's own words", () => {
    const one: AgentQuestion = {
      ...login,
      fields: [{ id: "code", kind: "code", label: "Code" }],
      answer: { askId: ASK, by: "user", fields: { code: "123456" } },
    };
    expect(answerSummary(one)).toBe("123456");
    expect(
      answerSummary({
        ...login,
        decline: "Keep them",
        answer: { askId: ASK, by: "user", declined: true },
      }),
    ).toBe("Keep them");
    expect(answerSummary({ ...plain, answer: { askId: ASK, by: "user", option: "A" } })).toBe(
      "Markdown",
    );
  });
});
