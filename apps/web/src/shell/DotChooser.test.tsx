// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { DotChooser } from "./DotChooser.tsx";

afterEach(cleanup);

it("lists every dot with the chosen one checked, and saves a new choice", () => {
  const anchor = createRef<HTMLElement>();
  const onChange = vi.fn();
  render(<DotChooser open anchor={anchor} value="coder" onChange={onChange} onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Your dot" });
  const choices = screen.getAllByRole("radio");
  expect(choices).toHaveLength(6);
  expect(screen.getByRole("radio", { name: "Coder" })).toHaveProperty("checked", true);
  fireEvent.click(screen.getByRole("radio", { name: "Finance" }));
  expect(onChange).toHaveBeenCalledWith("finance");
  expect(dialog.textContent).toContain("Your choice applies from the next task.");
});
