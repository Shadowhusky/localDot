import { describe, expect, it } from "vitest";
import { z } from "zod";
import { QuestionAnswerRequest } from "./agent-controls.ts";
import { askAnswered, askRequired, askValueProblem } from "./ask.ts";
import { parseEvent } from "./events.ts";
import { AskUserInput } from "./tools.ts";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0M";
const base = { v: 1, id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", seq: 0, t: 0, agent: "main" } as const;
const login = {
  question: "Sign in to your mail",
  fields: [
    { id: "email", kind: "email", label: "Email" },
    { id: "password", kind: "secret", label: "Password", target: [640, 400] },
  ],
  submit: "Sign in",
  decline: "Not now",
};

describe("ask_user fields", () => {
  it("takes up to four typed fields, and a plain question with options as before", () => {
    expect(AskUserInput.safeParse(login).success).toBe(true);
    expect(AskUserInput.safeParse({ question: "Which?", options: ["A", "B"] }).success).toBe(true);
    expect(AskUserInput.safeParse({ question: "Anything else?", allow_text: true }).success).toBe(
      true,
    );
    for (const kind of ["text", "longtext", "number", "date", "url", "phone", "file", "confirm"])
      expect(
        AskUserInput.safeParse({ question: "Q", fields: [{ id: "a", kind, label: "A" }] }).success,
      ).toBe(true);
    expect(
      AskUserInput.safeParse({
        question: "Q",
        fields: [
          { id: "pick", kind: "multichoice", label: "Pick", options: ["x", "y"] },
          { id: "otp", kind: "code", label: "Code", length: 6 },
          { id: "link", kind: "qr", label: "Scan", value: "https://example.test/pair" },
        ],
      }).success,
    ).toBe(true);
  });

  it("takes recommended options and required fields, and drops allow_text", () => {
    const parsed = AskUserInput.parse({
      question: "Which framework?",
      fields: [
        {
          id: "framework",
          kind: "choice",
          label: "Framework",
          options: ["Next.js", "Remix", "Astro"],
          recommended: 0,
          required: true,
        },
        { id: "notes", kind: "longtext", label: "Notes" },
      ],
    });
    expect(parsed.fields?.[0]).toMatchObject({ recommended: 0, required: true });
    expect(
      AskUserInput.parse({
        question: "Which?",
        options: ["A", "B"],
        recommended: 1,
        allow_text: true,
      }),
    ).toEqual({ question: "Which?", options: ["A", "B"], recommended: 1 });
    for (const input of [
      { question: "Which?", options: ["A"] },
      { question: "Which?", options: ["A", "B"], recommended: 2 },
      { question: "Which?", recommended: 0 },
      { ...login, recommended: 0 },
      {
        question: "Q",
        fields: [{ id: "a", kind: "choice", label: "A", options: ["x", "y"], recommended: 2 }],
      },
      { question: "Q", fields: [{ id: "a", kind: "text", label: "A", recommended: 0 }] },
      { question: "Q", fields: [{ id: "a", kind: "multichoice", label: "A", options: ["x"] }] },
    ])
      expect(AskUserInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it("refuses fields that do not fit their kind", () => {
    const field = (over: Record<string, unknown>) => ({
      question: "Q",
      fields: [{ id: "a", kind: "text", label: "A", ...over }],
    });
    for (const input of [
      { ...login, options: ["Yes", "No"] },
      field({ id: "Password" }),
      field({ id: "1st" }),
      field({ options: ["x"] }),
      field({ target: [1, 2] }),
      field({ length: 6 }),
      field({ value: "x" }),
      field({ kind: "choice" }),
      field({ kind: "qr" }),
      field({ kind: "wizard" }),
      { question: "Q", fields: [] },
      { question: "Q", fields: [login.fields[0], login.fields[0]] },
      {
        question: "Q",
        fields: Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, kind: "text", label: "F" })),
      },
    ])
      expect(AskUserInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it("declares a schema every provider accepts: no unions, tuples or patterns", () => {
    const text = JSON.stringify(z.toJSONSchema(AskUserInput));
    for (const shape of ["anyOf", "oneOf", "allOf", "prefixItems", "pattern"])
      expect(text).not.toContain(shape);
    expect(z.toJSONSchema(AskUserInput)).toMatchObject({
      properties: {
        fields: {
          type: "array",
          maxItems: 4,
          items: {
            properties: {
              target: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
            },
          },
        },
      },
    });
  });
});

describe("field answers", () => {
  it("checks each value against its kind", () => {
    const ok = [
      [{ kind: "text" }, "Ada"],
      [{ kind: "longtext" }, "line one\nline two"],
      [{ kind: "secret" }, " spaces kept "],
      [{ kind: "code", length: 6 }, "123456"],
      [{ kind: "choice", options: ["PDF"] }, "Something of my own"],
      [{ kind: "choice", options: ["PDF"] }, "Two lines\nof my own"],
      [{ kind: "choice", options: ["PDF"] }, { other: "ODT" }],
      [{ kind: "multichoice", options: ["a", "b"] }, ["b", "a"]],
      [
        { kind: "multichoice", options: ["a", "b"] },
        { selected: ["a"], other: "c" },
      ],
      [{ kind: "multichoice", options: ["a", "b"] }, { other: "c" }],
      [{ kind: "confirm" }, true],
      [{ kind: "qr" }, undefined],
      [{ kind: "number" }, "-3.5"],
      [{ kind: "date" }, "2026-10-09"],
      [{ kind: "email" }, "ada@example.test"],
      [{ kind: "url" }, "https://example.test/a"],
      [{ kind: "phone" }, "+44 20 7946 0958"],
      [{ kind: "file" }, "~/Downloads/report.pdf"],
    ] as const;
    for (const [field, value] of ok)
      expect(askValueProblem(field, value), JSON.stringify([field, value])).toBeUndefined();
    const bad = [
      [{ kind: "text" }, " "],
      [{ kind: "text" }, undefined],
      [{ kind: "text" }, "two\nlines"],
      [{ kind: "secret" }, "a\u0000b"],
      [{ kind: "code", length: 6 }, "12345"],
      [{ kind: "multichoice", options: ["a"] }, ["c"]],
      [{ kind: "multichoice", options: ["a"] }, ["a", "a"]],
      [{ kind: "multichoice", options: ["a"] }, []],
      [
        { kind: "multichoice", options: ["a"] },
        { selected: ["c"], other: "d" },
      ],
      [{ kind: "multichoice", options: ["a"] }, { other: " " }],
      [
        { kind: "choice", options: ["a"] },
        { selected: ["a"], other: "b" },
      ],
      [{ kind: "choice", options: ["a"] }, { other: "x".repeat(2001) }],
      [{ kind: "choice", options: ["a"] }, ["a"]],
      [{ kind: "confirm" }, undefined],
      [{ kind: "number" }, "three"],
      [{ kind: "date" }, "09/10/2026"],
      [{ kind: "email" }, "ada"],
      [{ kind: "url" }, "javascript:alert(1)"],
      [{ kind: "phone" }, "call me"],
      [{ kind: "file" }, "/etc/passwd"],
      [{ kind: "file" }, "~/../secret"],
      [{ kind: "text" }, true],
    ] as const;
    for (const [field, value] of bad)
      expect(askValueProblem(field, value), JSON.stringify([field, value])).toBeTypeOf("string");
    expect(askValueProblem({ kind: "email" }, "ada")).toBe("Enter an email address");
    expect(askValueProblem({ kind: "multichoice", options: ["a"] }, undefined)).toBe(
      "Pick at least one",
    );
  });

  it("asks for an answer only where a field needs one", () => {
    expect(askRequired({ kind: "text" })).toBe(true);
    expect(askRequired({ kind: "text", required: false })).toBe(false);
    for (const kind of ["secret", "code", "api_key", "qr"] as const)
      expect(askRequired({ kind, required: false }), kind).toBe(true);
    for (const blank of [" ", [], ""] as const) expect(askAnswered(blank)).toBe(false);
    for (const given of ["x", ["a"], true, { other: "x" }] as const)
      expect(askAnswered(given)).toBe(true);
  });

  it("answers a question with one of: an option or text, the fields, or a decline", () => {
    for (const body of [
      { askId: ID, option: "A" },
      { askId: ID, text: "Yes" },
      { askId: ID, fields: { email: "ada@example.test", password: "x", pick: ["a"], ok: true } },
      { askId: ID, fields: { pick: { selected: ["a"], other: "b" }, tone: { other: "warm" } } },
      { askId: ID, fields: {} },
      { askId: ID, declined: true },
    ])
      expect(QuestionAnswerRequest.safeParse(body).success, JSON.stringify(body)).toBe(true);
    for (const body of [
      { askId: ID },
      { askId: ID, option: "A", declined: true },
      { askId: ID, text: "Yes", fields: { a: "b" } },
      { askId: ID, fields: { Bad: "x" } },
      { askId: ID, fields: { a: "1", b: "2", c: "3", d: "4", e: "5" } },
      { askId: ID, fields: { pick: { selected: [], other: "b" } } },
      { askId: ID, fields: { pick: { other: "b", extra: true } } },
      { askId: ID, declined: false },
    ])
      expect(QuestionAnswerRequest.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });

  it("journals a field question and its answer, a secret only as provided", () => {
    const request = parseEvent({
      ...base,
      type: "ask.request",
      data: {
        askId: ID,
        question: "Sign in",
        options: [],
        allowText: false,
        fields: [
          { id: "email", kind: "email", label: "Email" },
          {
            id: "password",
            kind: "secret",
            label: "Password",
            target: {
              screen: "browser",
              point: { x: 800, y: 600 },
              bbox: { x: 1, y: 2, w: 3, h: 4 },
            },
          },
        ],
        submit: "Sign in",
      },
    });
    expect(request.type).toBe("ask.request");
    const answer = parseEvent({
      ...base,
      type: "ask.answer",
      data: {
        askId: ID,
        fields: { email: "ada@example.test", password: { provided: true } },
        by: "user",
      },
    });
    expect(answer.type).toBe("ask.answer");
    expect(() =>
      parseEvent({
        ...base,
        type: "ask.answer",
        data: { askId: ID, fields: { password: { value: "x" } }, by: "user" },
      }),
    ).toThrow();
    expect(
      parseEvent({ ...base, type: "ask.answer", data: { askId: ID, declined: true, by: "user" } })
        .type,
    ).toBe("ask.answer");
    expect(
      parseEvent({
        ...base,
        type: "ask.answer",
        data: {
          askId: ID,
          fields: { tone: { other: "warm" }, parts: { selected: ["a"], other: "b" } },
          skipped: ["notes"],
          by: "user",
        },
      }).data,
    ).toMatchObject({ skipped: ["notes"] });
    expect(() =>
      parseEvent({
        ...base,
        type: "ask.answer",
        data: { askId: ID, fields: {}, skipped: ["Notes"], by: "user" },
      }),
    ).toThrow();
  });
});
