// @vitest-environment jsdom

import type { CredentialRequest, QuestionAnswerRequest } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { KeysController } from "../keys/useKeys.ts";
import { AskForm } from "./AskForm.tsx";
import { AskDraft } from "./ask-draft.ts";

const credential: CredentialRequest = {
  binding: {
    id: "search",
    kind: "http",
    hosts: ["api.example.test"],
    header: "X-API-Key",
    format: "raw",
  },
  metadata: { label: "Catalog search", service: "Example", description: "Find products" },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function fixture() {
  const draft = new AskDraft({
    askId: "01JXYZ00000000000000000001",
    question: "Add catalog access?",
    options: [],
    allowText: false,
    fields: [{ id: "key", kind: "api_key", label: "API key", credential }],
  });
  const answer = vi.fn(async (_request: QuestionAnswerRequest) => true);
  const save = vi.fn<KeysController["save"]>(async () => ({
    restart: false,
    key: { ...credential.binding, metadata: credential.metadata, createdAt: "", updatedAt: "" },
  }));
  const props = { draft, layout: "thread" as const, answer, saveKey: save };
  const view = render(<AskForm {...props} />);
  const input = () => screen.getByRole("textbox", { name: "API key" }) as HTMLInputElement;
  const submit = async () =>
    act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Save a service key" }));
    });
  return { ...view, draft, answer, save, props, input, submit };
}
it("keeps even arbitrary key values out of draft/state and resumes only with a verified saved marker", async () => {
  const f = fixture();
  const field = f.input();
  fireEvent.change(field, { target: { value: "arbitrary-secret-value" } });
  expect(JSON.stringify(f.draft.state())).not.toContain("arbitrary-secret-value");
  expect(screen.getByText("api.example.test")).toBeTruthy();
  expect(field.closest(".keys-secret")).toBeTruthy();
  expect(field.autocomplete).toBe("off");
  await f.submit();
  expect(field.value).toBe("");
  expect(f.save).toHaveBeenCalledExactlyOnceWith(
    credential.binding,
    "arbitrary-secret-value",
    credential.metadata,
  );
  expect(f.answer).toHaveBeenCalledExactlyOnceWith({
    askId: f.draft.question.askId,
    fields: { key: true },
  });
  expect(JSON.stringify(f.draft.state())).not.toContain("arbitrary-secret-value");
});
it("does not continue after a failed save and clears the secret", async () => {
  const f = fixture();
  f.save.mockRejectedValueOnce(new Error("Service unavailable"));
  fireEvent.change(f.input(), { target: { value: "private-value" } });
  await f.submit();
  expect(f.answer).not.toHaveBeenCalled();
  expect(f.input().value).toBe("");
  expect(screen.getByRole("alert")).toBeTruthy();
});
it("retries only delivery of the saved marker when the answer was lost", async () => {
  const f = fixture();
  f.answer.mockResolvedValueOnce(false);
  fireEvent.change(f.input(), { target: { value: "private-value" } });
  await f.submit();
  expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  await f.submit();
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.answer).toHaveBeenCalledTimes(2);
});
it("refuses a save result bound to a different service", async () => {
  const f = fixture();
  f.save.mockResolvedValueOnce({
    restart: false,
    key: {
      ...credential.binding,
      hosts: ["other.example.test"],
      metadata: credential.metadata,
      createdAt: "",
      updatedAt: "",
    },
  });
  fireEvent.change(f.input(), { target: { value: "private-value" } });
  await f.submit();
  expect(f.answer).not.toHaveBeenCalled();
});
it("clears entered keys on hiding, unavailable task and unmount", () => {
  const f = fixture();
  const input = f.input();
  const type = () => fireEvent.change(input, { target: { value: "private-value" } });
  type();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  expect(input.value).toBe("");
  type();
  f.rerender(<AskForm {...f.props} reason="Paused" />);
  expect(input.value).toBe("");
  f.rerender(<AskForm {...f.props} />);
  type();
  f.unmount();
  expect(input.value).toBe("");
});
it("declines without saving or exposing an entered value", async () => {
  const f = fixture();
  fireEvent.change(f.input(), { target: { value: "private-value" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  });
  expect(f.save).not.toHaveBeenCalled();
  expect(f.input().value).toBe("");
  expect(f.answer).toHaveBeenCalledWith({ askId: f.draft.question.askId, declined: true });
});
