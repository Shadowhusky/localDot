import { expect, it } from "vitest";
import {
  BudgetRaiseRequest,
  HandbackRequest,
  QuestionAnswerRequest,
  StopOutcome,
  TaskModelSelection,
} from "./agent-controls.ts";
import { AskAnswer, TakeoverEnd } from "./events.ts";

const id = "01JXYZ00000000000000000001";
it("keeps accepted question answers and hand-back notes representable by their real event contracts", () => {
  const answer = QuestionAnswerRequest.parse({ askId: id, text: "🙂".repeat(1000) });
  const note = HandbackRequest.parse({ requestId: id, note: "🙂".repeat(500) });
  const envelope = { v: 1, id, seq: 0, t: 0, agent: "main" };
  expect(
    AskAnswer.safeParse({ ...envelope, type: "ask.answer", data: { ...answer, by: "user" } })
      .success,
  ).toBe(true);
  expect(
    TakeoverEnd.safeParse({ ...envelope, type: "takeover.end", data: { ...note, by: "user" } })
      .success,
  ).toBe(true);
  expect(QuestionAnswerRequest.safeParse({ askId: id, text: `${answer.text}🙂` }).success).toBe(
    false,
  );
  expect(HandbackRequest.safeParse({ ...note, sessionId: id }).success).toBe(false);
  expect(HandbackRequest.safeParse({ requestId: id, note: `${note.note}🙂` }).success).toBe(false);
  expect(QuestionAnswerRequest.safeParse({ askId: id, option: "Z" }).success).toBe(false);
});
it("requires explicit typed containment facts and safe bounded cleanup errors, never status-like truthy values", () => {
  const stopped = {
    revoked: false,
    paused: false,
    closed: true,
    stopped: true,
    errors: ["pause: could not confirm completion"],
  };
  expect(StopOutcome.parse(stopped)).toEqual(stopped);
  for (const bad of [
    { ...stopped, stopped: "yes" },
    { ...stopped, status: 202 },
    { ...stopped, errors: ["raw private diagnostic"] },
  ])
    expect(StopOutcome.safeParse(bad).success).toBe(false);
});

it("rejects invalid ceilings and exposes only a strict frozen model identity without keys or price", () => {
  for (const budgetUSD of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10_001, 0.0000001])
    expect(BudgetRaiseRequest.safeParse({ budgetUSD }).success).toBe(false);
  expect(BudgetRaiseRequest.parse({ budgetUSD: 0.000001 })).toEqual({ budgetUSD: 0.000001 });
  expect(BudgetRaiseRequest.safeParse({ budgetUSD: 8, spentUSD: 0 }).success).toBe(false);
  expect(
    TaskModelSelection.parse({
      kind: "api",
      roles: [{ role: "main", provider: "anthropic", model: "fixture-model" }],
    }).kind,
  ).toBe("api");
  for (const value of [
    { kind: "chatgpt", model: "fixture", key: "surrogate" },
    { kind: "api", roles: [{ role: "main", provider: "anthropic", model: "fixture", price: 1 }] },
    { kind: "api", roles: [{ role: "fast", provider: "anthropic", model: "fixture" }] },
    {
      kind: "api",
      roles: [
        { role: "main", provider: "anthropic", model: "fixture" },
        { role: "main", provider: "ollama", model: "other" },
      ],
    },
  ])
    expect(TaskModelSelection.safeParse(value).success).toBe(false);
});
