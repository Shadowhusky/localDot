// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageCounter } from "./PageCounter.tsx";

afterEach(cleanup);

function counter(page = 12) {
  const onGo = vi.fn();
  render(<PageCounter page={page} count={300} noun="Page" onGo={onGo} />);
  return { onGo, field: screen.getByRole("textbox", { name: "Page number, of 300" }) };
}

describe("the page counter", () => {
  it("goes to a typed page on Return, clamped to the document", () => {
    const { onGo, field } = counter();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "120" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onGo).toHaveBeenLastCalledWith(120);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "9999" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onGo).toHaveBeenLastCalledWith(300);
  });

  it("keeps only digits, and puts back the page on show on Esc or when left", () => {
    const { onGo, field } = counter();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "4a5" } });
    expect((field as HTMLInputElement).value).toBe("45");
    fireEvent.keyDown(field, { key: "Escape" });
    expect((field as HTMLInputElement).value).toBe("12");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "7" } });
    fireEvent.blur(field);
    expect((field as HTMLInputElement).value).toBe("12");
    expect(onGo).not.toHaveBeenCalled();
  });

  it("steps with the arrows and says when there is no page further", () => {
    const { onGo } = counter(1);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onGo).toHaveBeenCalledWith(2);
    expect(
      screen.getByRole("button", { name: "Previous page" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });
});
