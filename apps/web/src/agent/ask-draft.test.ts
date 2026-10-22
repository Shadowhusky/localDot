// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AskDraft, useAskDraft } from "./ask-draft.ts";
import type { AgentQuestion } from "./model.ts";

const login: AgentQuestion = {
  askId: "01JXYZ00000000000000000001",
  question: "Sign in to the bank.",
  options: [],
  allowText: false,
  fields: [
    { id: "user", kind: "text", label: "Username" },
    { id: "password", kind: "secret", label: "Password" },
  ],
};

describe("AskDraft", () => {
  it("forgets the secret before the answer leaves, and holds a sent answer", async () => {
    const draft = new AskDraft(login);
    draft.set("user", "henry");
    draft.set("password", "correct horse");
    const seen: unknown[] = [];
    const answer = vi.fn(async (request: unknown) => {
      seen.push(draft.state().draft.values.password);
      return request !== null;
    });
    await expect(draft.submit(answer)).resolves.toBe(true);
    expect(answer).toHaveBeenCalledWith({
      askId: login.askId,
      fields: { user: "henry", password: "correct horse" },
    });
    expect(seen).toEqual([""]);
    expect(JSON.stringify(draft.state())).not.toContain("correct horse");
    expect(draft.state().sending).toBe("answer");
    await expect(draft.submit(answer)).resolves.toBe(false);
    expect(answer).toHaveBeenCalledOnce();
  });

  it("says when an answer didn't arrive and lets it be sent again", async () => {
    const draft = new AskDraft(login);
    draft.set("user", "henry");
    draft.set("password", "pw");
    await draft.submit(async () => false);
    expect(draft.state()).toMatchObject({
      sending: null,
      failed: expect.stringMatching(/didn't reach/),
    });
    draft.set("password", "pw");
    expect(draft.state().failed).toBeNull();
  });

  it("keeps a key out of a plain field but types a secret as given", () => {
    const draft = new AskDraft(login);
    const key = `sk-proj-${"k".repeat(40)}`;
    draft.set("user", key);
    expect(draft.state().draft.values.user).toBe("");
    expect(draft.state().keys.has("user")).toBe(true);
    draft.set("password", key);
    expect(draft.state().draft.values.password).toBe(key);
    draft.set("user", "henry");
    expect(draft.state().keys.has("user")).toBe(false);
  });

  it("picks a choice's Other row while it has text, and again when it is used", () => {
    const draft = new AskDraft({
      ...login,
      fields: [{ id: "tone", kind: "choice", label: "Tone", options: ["Formal", "Plain"] }],
    });
    draft.set("tone", "0");
    draft.setOther("tone", "Warm");
    expect(draft.state().draft.values.tone).toBe("other");
    draft.set("tone", "1");
    expect(draft.state().draft.other.tone).toBe("Warm");
    draft.setOther("tone", "Warm");
    expect(draft.state().draft.values.tone).toBe("other");
    draft.setOther("tone", "");
    expect(draft.state().draft.values.tone).toBe("");
  });

  it("keeps a multichoice's picks beside its own words", () => {
    const draft = new AskDraft({
      ...login,
      fields: [
        { id: "parts", kind: "multichoice", label: "Include", options: ["Totals", "Charts"] },
      ],
    });
    draft.set("parts", ["1"]);
    draft.setOther("parts", "Notes");
    expect(draft.state().draft).toEqual({ values: { parts: ["1"] }, other: { parts: "Notes" } });
  });

  it("sends nothing while a field that needs an answer is blank, and shows every problem", async () => {
    const draft = new AskDraft(login);
    const answer = vi.fn(async () => true);
    await expect(draft.submit(answer)).resolves.toBe(false);
    expect(answer).not.toHaveBeenCalled();
    expect(draft.state().checked).toBe(true);
  });
});

it("keeps one draft per question and forgets its secrets once the question goes", () => {
  const { result, rerender } = renderHook(({ question }) => useAskDraft(question), {
    initialProps: { question: login as AgentQuestion | undefined },
  });
  const first = result.current;
  act(() => first?.set("password", "pw"));
  rerender({ question: { ...login, answer: undefined } });
  expect(result.current).toBe(first);
  rerender({ question: undefined });
  expect(result.current).toBeNull();
  expect(first?.state().draft.values.password).toBe("");
});
