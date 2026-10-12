// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SignIn } from "./SignIn.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("hands over the command that makes a sign-in link, ready to paste", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(<SignIn state="first" />);
  expect(screen.getByText("localdot open").tagName).toBe("CODE");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
  expect(writeText).toHaveBeenCalledWith("localdot open");
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
});

it("speaks up only when a link failed, not on a first visit", () => {
  const view = render(<SignIn state="first" />);
  expect(screen.queryByRole("alert")).toBeNull();
  view.rerender(<SignIn state="expired" />);
  expect(screen.getByRole("alert").textContent).toBe(
    "That link has expired or was already used. Run this for a fresh one:",
  );
  view.rerender(<SignIn state="signed-out" />);
  expect(screen.getByRole("alert").textContent).toBe(
    "This browser was signed out. Run this to sign in again:",
  );
});

it("says why copying is unavailable instead of failing quietly", () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
  render(<SignIn state="first" />);
  expect(screen.getByRole("button", { name: "Copy" }).getAttribute("aria-disabled")).toBe("true");
});

it("signs the Home Screen app in from a pasted link instead of Terminal", () => {
  const view = render(<SignIn state="first" homeScreen />);
  expect(screen.queryByText("localdot open")).toBeNull();
  expect(screen.getByLabelText("Sign-in link")).toBeTruthy();
  expect(screen.getByText(/browser where you’re already signed in/)).toBeTruthy();
  expect(screen.queryByText(/Safari/)).toBeNull();
  view.rerender(<SignIn state="expired" homeScreen />);
  expect(
    screen.getByText(
      "That link has expired or was already used. Create a fresh link in the browser where you’re signed in.",
    ),
  ).toBeTruthy();
});
