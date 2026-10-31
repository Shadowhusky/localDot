// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LocalDotSwitcher } from "./LocalDotSwitcher.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const OFFICE = { name: "Office PC", url: "https://office.example:4750", browserOnly: false };

it("names this localDot and opens another at its own address, or Settings to add one", () => {
  const onOpen = vi.fn();
  const onManage = vi.fn();
  render(
    <LocalDotSwitcher
      name="Studio Mac"
      others={[
        OFFICE,
        {
          name: "Lab",
          url: "https://lab.example:4750",
          persona: "coder",
          accessory: "cap",
          browserOnly: true,
        },
      ]}
      onOpen={onOpen}
      onManage={onManage}
    />,
  );
  const trigger = screen.getByRole("button", { name: "localDot: Studio Mac. Switch localDot" });
  fireEvent.click(trigger);
  const menu = screen.getByRole("menu", { name: "localDots" });
  expect(menu.textContent).toContain("Studio Mac");
  expect(menu.textContent).toContain("office.example:4750");
  // Each other localDot by its dot as well as its name.
  expect(screen.getByRole("menuitem", { name: /Lab/ }).querySelector(".dot")).not.toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: /Office PC/ }));
  expect(onOpen).toHaveBeenCalledWith("https://office.example:4750");
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
      others={[OFFICE]}
      here={here}
      onOpen={vi.fn()}
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
