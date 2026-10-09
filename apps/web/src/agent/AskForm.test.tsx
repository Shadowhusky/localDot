// @vitest-environment jsdom

import type { QuestionAnswerRequest } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AskForm, type AskLayout } from "./AskForm.tsx";
import { AskDraft } from "./ask-draft.ts";
import type { AgentQuestion } from "./model.ts";

afterEach(cleanup);

const ASK = "01JXYZ00000000000000000001";
const login: AgentQuestion = {
  askId: ASK,
  question: "Sign in to the bank.",
  options: [],
  allowText: false,
  fields: [
    { id: "user", kind: "text", label: "Username" },
    { id: "password", kind: "secret", label: "Password" },
  ],
  submit: "Sign in",
};

function mount(question: AgentQuestion, layout: AskLayout = "thread") {
  const draft = new AskDraft(question);
  const answer = vi.fn(async (_request: QuestionAnswerRequest) => true);
  const view = render(<AskForm draft={draft} layout={layout} answer={answer} />);
  return { ...view, draft, answer };
}

it("answers a sign-in with its fields, the password masked and gone once sent", async () => {
  const f = mount(login);
  const user = screen.getByRole("textbox", { name: "Username" });
  const password = screen.getByLabelText("Password") as HTMLInputElement;
  expect(user.getAttribute("autocomplete")).toBe("username");
  expect(password.type).toBe("password");
  expect(password.getAttribute("autocomplete")).toBe("current-password");
  expect(password.value).toBe("");
  expect(screen.getByText("dot types this in for you and never sees it.")).toBeTruthy();
  const send = screen.getByRole("button", { name: "Sign in" });
  expect(send.getAttribute("aria-disabled")).toBe("true");
  fireEvent.change(user, { target: { value: "henry" } });
  fireEvent.change(password, { target: { value: "correct horse" } });
  fireEvent.click(screen.getByRole("button", { name: "Show password" }));
  expect(password.type).toBe("text");
  await act(async () => {
    fireEvent.submit(screen.getByRole("form", { name: "Answer dot" }));
  });
  expect(f.answer).toHaveBeenCalledExactlyOnceWith({
    askId: ASK,
    fields: { user: "henry", password: "correct horse" },
  });
  expect(password.value).toBe("");
  expect(f.container.innerHTML).not.toContain("correct horse");
});

it("fills every code cell from one paste and offers the text message's code", () => {
  const f = mount({
    ...login,
    fields: [{ id: "code", kind: "code", label: "Code", length: 6 }],
    submit: "Send code",
  });
  const cells = screen.getAllByRole("textbox", { name: /^Code, \d of 6$/ }) as HTMLInputElement[];
  expect(cells).toHaveLength(6);
  expect(cells[0]?.getAttribute("autocomplete")).toBe("one-time-code");
  expect(cells[0]?.getAttribute("inputmode")).toBe("numeric");
  fireEvent.paste(cells[2] as HTMLInputElement, { clipboardData: { getData: () => "481 516" } });
  expect(cells.map((cell) => cell.value).join("")).toBe("481516");
  expect(f.draft.state().draft.values.code).toBe("481516");
  expect(screen.getByRole("button", { name: "Send code" }).hasAttribute("aria-disabled")).toBe(
    false,
  );
});

it("grows out of the island with dot's question as its title and dot's verbs", async () => {
  const f = mount(
    {
      ...login,
      question: "Delete the 12 old drafts in your mail?",
      fields: [{ id: "sure", kind: "confirm", label: "Delete 12 drafts" }],
      submit: "Delete",
      decline: "Keep them",
    },
    "island",
  );
  expect(
    screen.getByRole("heading", { name: "Delete the 12 old drafts in your mail?" }),
  ).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Keep them" }));
  });
  expect(f.answer).toHaveBeenCalledExactlyOnceWith({ askId: ASK, declined: true });
});

it("says a problem as the field is typed in, never before it is left", () => {
  mount({ ...login, fields: [{ id: "mail", kind: "email", label: "Email" }] });
  const field = screen.getByRole("textbox", { name: "Email" });
  fireEvent.change(field, { target: { value: "henry" } });
  expect(screen.queryByText("Enter an email address")).toBeNull();
  fireEvent.blur(field);
  expect(screen.getByText("Enter an email address")).toBeTruthy();
  fireEvent.change(field, { target: { value: "henry@example.test" } });
  expect(screen.queryByText("Enter an email address")).toBeNull();
});

it("shows a QR code for another device, and its code on request", () => {
  mount({
    ...login,
    fields: [
      {
        id: "pair",
        kind: "qr",
        label: "Link your phone",
        value: "https://pair.example.test/a1b2c3",
        hint: "Code: A1B2-C3",
      },
    ],
  });
  expect(screen.getByRole("img", { name: "QR code to scan with another device" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "On this phone? Use a code instead" }));
  expect(screen.getByText("Code: A1B2-C3")).toBeTruthy();
  expect(screen.getByRole("link").getAttribute("rel")).toBe("noopener noreferrer");
});

it("puts a chosen file on the computer and answers with its path there", async () => {
  const draft = new AskDraft({ ...login, fields: [{ id: "photo", kind: "file", label: "Photo" }] });
  const upload = vi.fn(async (file: File) => `~/Downloads/${file.name}`);
  const { container } = render(
    <AskForm draft={draft} layout="thread" answer={async () => true} upload={upload} />,
  );
  const input = container.querySelector("input[type='file']") as HTMLInputElement;
  const file = new File(["x"], "me.png", { type: "image/png" });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  expect(upload).toHaveBeenCalledOnce();
  expect(draft.state().draft.values.photo).toBe("~/Downloads/me.png");
  expect(screen.getByText("On your computer, in Downloads")).toBeTruthy();
});
