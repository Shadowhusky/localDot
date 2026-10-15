// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LocalDotSwitcher } from "./LocalDotSwitcher.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("names this localDot and opens another at its own address, or Settings to add one", () => {
  const assign = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign });
  const onManage = vi.fn();
  render(
    <LocalDotSwitcher
      name="Studio Mac"
      others={[{ name: "Office PC", url: "https://office.example:4750" }]}
      onManage={onManage}
    />,
  );
  const trigger = screen.getByRole("button", { name: "localDot: Studio Mac. Switch localDot" });
  fireEvent.click(trigger);
  const menu = screen.getByRole("menu", { name: "localDots" });
  expect(menu.textContent).toContain("Studio Mac");
  expect(menu.textContent).toContain("office.example:4750");
  fireEvent.click(screen.getByRole("menuitem", { name: /Office PC/ }));
  expect(assign).toHaveBeenCalledWith("https://office.example:4750");
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitem", { name: "Add or manage localDots…" }));
  expect(onManage).toHaveBeenCalledWith(trigger);
});
