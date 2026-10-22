import { describe, expect, it } from "vitest";
import {
  answerRequest,
  answerSummary,
  askFields,
  composerReply,
  type Draft,
  emptyDraft,
  fieldProblem,
  fieldValue,
  LEFT_TO_DOT,
  leftToDot,
  marksOptional,
  OTHER,
} from "./ask-form.ts";
import type { AgentQuestion } from "./model.ts";

const ASK = "01JXYZ00000000000000000001";
const login: AgentQuestion = {
  askId: ASK,
  question: "Sign in to the bank.",
  options: [],
  allowText: false,
  fields: [
    { id: "email", kind: "email", label: "Email", required: true },
    { id: "password", kind: "secret", label: "Password", required: true },
  ],
  submit: "Sign in",
};
// A quick choice as the daemon asks it: one optional field.
const quick: AgentQuestion = {
  askId: ASK,
  question: "Which format?",
  options: [],
  allowText: false,
  fields: [
    {
      id: "answer",
      kind: "choice",
      label: "Your answer",
      options: ["Markdown", "PDF"],
      recommended: 1,
      required: false,
    },
  ],
};
const setup: AgentQuestion = {
  askId: ASK,
  question: "How should I set up the project?",
  options: [],
  allowText: false,
  fields: [
    { id: "name", kind: "text", label: "Project name", required: true },
    {
      id: "framework",
      kind: "choice",
      label: "Framework",
      options: ["Next.js", "Remix"],
      required: false,
    },
    {
      id: "extras",
      kind: "multichoice",
      label: "Extras",
      options: ["ESLint", "Tests"],
      required: false,
    },
    { id: "notes", kind: "longtext", label: "Notes", required: false },
  ],
  submit: "Continue",
};
// Asked before every question had fields.
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
  it("gives every choice and multichoice an Other row, and says which fields need an answer", () => {
    expect(askFields(setup)).toEqual([
      expect.objectContaining({ id: "name", required: true, other: false }),
      expect.objectContaining({ id: "framework", required: false, other: true }),
      expect.objectContaining({ id: "extras", required: false, other: true }),
      expect.objectContaining({ id: "notes", required: false, other: false }),
    ]);
    expect(askFields(quick)[0]).toMatchObject({ recommended: 1, required: false, other: true });
  });

  it("needs every answer of a question asked before fields could be left blank", () => {
    const older: AgentQuestion = {
      ...login,
      fields: [{ id: "tone", kind: "choice", label: "Tone", options: ["Formal", "Warm"] }],
    };
    expect(askFields(older)[0]?.required).toBe(true);
    expect(askFields(plain)).toEqual([
      expect.objectContaining({ kind: "choice", options: ["Markdown", "PDF"], other: true }),
    ]);
    expect(askFields({ ...plain, allowText: false })[0]?.other).toBe(false);
    expect(askFields({ ...plain, options: [] })[0]?.kind).toBe("longtext");
  });

  it("marks optional fields only where a form mixes them with ones that need an answer", () => {
    expect(marksOptional(askFields(setup))).toBe(true);
    expect(marksOptional(askFields(quick))).toBe(false);
    expect(marksOptional(askFields(login))).toBe(false);
  });

  it("does not invent a code length when the page has not specified it", () => {
    const code = (length?: number): AgentQuestion => ({
      ...login,
      fields: [{ id: "code", kind: "code", label: "Code", ...(length ? { length } : {}) }],
    });
    expect(askFields(code())[0]?.length).toBeUndefined();
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

  it("says what a field that needs an answer is missing, and what is wrong with a value", () => {
    const [email, password] = fields as [(typeof fields)[number], (typeof fields)[number]];
    expect(fieldProblem(email, emptyDraft(fields), fields)).toBe("Fill this in");
    expect(fieldProblem(email, draft({ email: "henry", password: "x" }), fields)).toBe(
      "Enter an email address",
    );
    expect(fieldProblem(password, draft({ email: "a@b.test", password: "" }), fields)).toBe(
      "Fill this in",
    );
    expect(answerRequest(login, fields, draft({ email: "henry", password: "x" }))).toBeUndefined();
  });

  it("leaves optional fields blank, but still checks what was filled in", () => {
    const all = askFields(setup);
    const blank = emptyDraft(all);
    expect(all.map((field) => fieldProblem(field, blank, all))).toEqual([
      "Fill this in",
      undefined,
      undefined,
      undefined,
    ]);
    expect(answerRequest(setup, all, draft({ ...blank.values, name: "Atlas" }))).toEqual({
      askId: ASK,
      fields: { name: "Atlas" },
    });
    const number: AgentQuestion = {
      ...setup,
      fields: [{ id: "guests", kind: "number", label: "Guests", required: false }],
    };
    const guests = askFields(number);
    expect(fieldProblem(guests[0] as (typeof guests)[number], draft({ guests: "a few" }))).toBe(
      "Enter a number",
    );
    expect(answerRequest(number, guests, draft({ guests: "a few" }))).toBeUndefined();
  });

  it("takes a choice's own words as its text, and a multichoice's beside its picks", () => {
    const all = askFields(setup);
    const values = draft(
      { name: "Atlas", framework: OTHER, extras: ["1"], notes: "" },
      { framework: " SvelteKit ", extras: " Storybook " },
    );
    expect(fieldValue(all[1] as (typeof all)[number], values)).toBe("SvelteKit");
    expect(answerRequest(setup, all, values)).toEqual({
      askId: ASK,
      fields: {
        name: "Atlas",
        framework: "SvelteKit",
        extras: { selected: ["Tests"], other: "Storybook" },
      },
    });
    const picked = draft({ name: "Atlas", framework: "1", extras: [] }, { framework: "kept" });
    expect(answerRequest(setup, all, picked)?.fields).toEqual({
      name: "Atlas",
      framework: "Remix",
    });
    const words = draft({ name: "Atlas", extras: [] }, { extras: "Docs" });
    expect(answerRequest(setup, all, words)?.fields).toEqual({
      name: "Atlas",
      extras: { other: "Docs" },
    });
  });

  it("leaves it all to dot only when nothing is filled in and nothing needs to be", () => {
    const one = askFields(quick);
    expect(leftToDot(one, emptyDraft(one))).toBe(true);
    expect(leftToDot(one, draft({ answer: "0" }))).toBe(false);
    expect(leftToDot(one, draft({ answer: OTHER }, { answer: "Word" }))).toBe(false);
    expect(answerRequest(quick, one, emptyDraft(one))).toEqual({ askId: ASK, fields: {} });
    expect(leftToDot(askFields(setup), emptyDraft(askFields(setup)))).toBe(false);
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
      fields: [{ id: "sure", kind: "confirm", label: "Delete 12 drafts", required: true }],
    };
    expect(answerRequest(confirm, askFields(confirm), draft({ sure: false }))).toEqual({
      askId: ASK,
      fields: { sure: true },
    });
    const mixed: AgentQuestion = {
      ...login,
      fields: [
        { id: "name", kind: "text", label: "Name", required: true },
        { id: "sure", kind: "confirm", label: "I agree", required: true },
      ],
    };
    const both = askFields(mixed);
    expect(
      fieldProblem(both[1] as (typeof both)[number], draft({ name: "Sam", sure: false }), both),
    ).toBe("Confirm to continue");
    const qr: AgentQuestion = {
      ...login,
      fields: [{ id: "pair", kind: "qr", label: "Link", value: "https://pair.example.test/a" }],
    };
    expect(answerRequest(qr, askFields(qr), emptyDraft(askFields(qr)))).toEqual({
      askId: ASK,
      fields: { pair: true },
    });
  });
});

describe("composerReply", () => {
  it("answers a lone choice with the option the message names, or as its own words", () => {
    expect(composerReply(quick, " pdf ")).toEqual({
      kind: "answer",
      request: { askId: ASK, fields: { answer: "PDF" } },
    });
    expect(composerReply(quick, "Both, please")).toEqual({
      kind: "answer",
      request: { askId: ASK, fields: { answer: "Both, please" } },
    });
    const pick: AgentQuestion = {
      ...quick,
      fields: [
        { id: "parts", kind: "multichoice", label: "Include", options: ["Totals", "Charts"] },
      ],
    };
    expect(composerReply(pick, "charts")).toEqual({
      kind: "answer",
      request: { askId: ASK, fields: { parts: ["Charts"] } },
    });
    expect(composerReply(pick, "Everything\nbut the notes")).toEqual({
      kind: "answer",
      request: { askId: ASK, fields: { parts: { other: "Everything\nbut the notes" } } },
    });
  });

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
      ...setup,
      fields: [{ id: "reply", kind: "longtext", label: "Reply" }],
    };
    expect(composerReply(one, "Thanks, see you Friday")).toEqual({
      kind: "answer",
      request: { askId: ASK, fields: { reply: "Thanks, see you Friday" } },
    });
    const mail: AgentQuestion = {
      ...setup,
      fields: [{ id: "to", kind: "email", label: "To" }],
    };
    expect(composerReply(mail, "use my work account").kind).toBe("decline");
    expect(composerReply(setup, "a").kind).toBe("decline");
  });

  it("turns the question down for a message with files, so dot reads both at once", () => {
    expect(composerReply(quick, "PDF", true)).toEqual({
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

  it("shows own words with any picks, and only the fields answered", () => {
    expect(
      answerSummary({
        ...setup,
        answer: {
          askId: ASK,
          by: "user",
          fields: {
            name: "Atlas",
            framework: { other: "SvelteKit" },
            extras: { selected: ["Tests"], other: "Storybook" },
          },
          skipped: ["notes"],
        },
      }),
    ).toBe("Project name: Atlas\nFramework: SvelteKit\nExtras: Tests, Storybook");
    expect(
      answerSummary({
        ...quick,
        answer: { askId: ASK, by: "user", fields: {}, skipped: ["answer"] },
      }),
    ).toBe(LEFT_TO_DOT);
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
