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

it("lists the dots on this computer and switches to one, asking before stopping another", () => {
  const dots = [
    { id: "main", name: "Main", port: 4750, self: true, main: true, state: "running" as const },
    { id: "work", name: "Work", port: 5750, self: false, main: false, state: "stopped" as const },
    { id: "lab", name: "Lab", port: 6750, self: false, main: false, state: "running" as const },
  ];
  const here = {
    dots,
    manage: true,
    busy: null,
    refresh: vi.fn(),
    open: vi.fn(async () => null),
    start: vi.fn(async () => null),
    stop: vi.fn(async () => null),
  };
  const onAddHere = vi.fn();
  render(
    <LocalDotSwitcher
      name="Main"
      others={[{ name: "Office PC", url: "https://office.example:4750" }]}
      here={here}
      onManage={vi.fn()}
      onAddHere={onAddHere}
    />,
  );
  const trigger = screen.getByRole("button", { name: "localDot: Main. Switch localDot" });
  fireEvent.click(trigger);
  expect(here.refresh).toHaveBeenCalledTimes(1);
  const group = screen.getByRole("group", { name: "On this computer" });
  expect(group.textContent).toContain("Stopped");
  expect(screen.getByRole("group", { name: "Your other localDots" }).textContent).toContain(
    "Office PC",
  );
  fireEvent.click(screen.getByRole("menuitem", { name: /^Work/ }));
  expect(here.open).toHaveBeenCalledWith(dots[1]);

  fireEvent.click(trigger);
  expect(screen.queryByRole("menuitem", { name: "Stop Work…" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Stop Lab…" }));
  expect(here.stop).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(here.stop).toHaveBeenCalledWith(dots[2]);

  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitem", { name: "Add a dot on this computer…" }));
  expect(onAddHere).toHaveBeenCalledWith(trigger);
});
