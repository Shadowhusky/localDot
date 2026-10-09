// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeScreenSignIn } from "./HomeScreenSignIn.tsx";

const ORIGIN = "https://mac.example.ts.net";
const CODE = "C".repeat(43);

afterEach(() => cleanup());

function paste(text: string) {
  fireEvent.change(screen.getByLabelText("Sign-in link"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("Home Screen sign-in", () => {
  it("hands a pasted link for this address to the one-use exchange", () => {
    const go = vi.fn();
    render(<HomeScreenSignIn origin={ORIGIN} go={go} />);
    paste(`${ORIGIN}/#code=${CODE}`);
    expect(go).toHaveBeenCalledWith(CODE);
    expect((screen.getByLabelText("Sign-in link") as HTMLInputElement).value).toBe("");
  });

  it("refuses a link for another address or a token link, and says what to do", () => {
    const go = vi.fn();
    render(<HomeScreenSignIn origin={ORIGIN} go={go} />);
    paste(`https://evil.example/#code=${CODE}`);
    paste(`${ORIGIN}/#token=${CODE}`);
    expect(go).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "That isn't a localDot sign-in link for this address. Copy a fresh one in Safari.",
      ),
    ).toBeTruthy();
  });

  it("does nothing until something is pasted", () => {
    const go = vi.fn();
    render(<HomeScreenSignIn origin={ORIGIN} go={go} />);
    fireEvent.submit(screen.getByRole("form", { name: "Sign in this app" }));
    expect(go).not.toHaveBeenCalled();
    expect(screen.queryByText(/isn't a localDot sign-in link/)).toBeNull();
  });

  it("explains an expired link", () => {
    render(<HomeScreenSignIn origin={ORIGIN} go={vi.fn()} rejected />);
    expect(
      screen.getByText("That link has expired or was already used. Copy a fresh one in Safari."),
    ).toBeTruthy();
  });
});
