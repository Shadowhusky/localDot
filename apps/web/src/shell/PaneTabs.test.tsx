// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { PaneTabs, type TheatrePane } from "./PaneTabs.tsx";

it("uses one roving tab stop with arrow, Home and End navigation", () => {
  function Fixture() {
    const [pane, set] = useState<TheatrePane>("computer");
    return <PaneTabs selected={pane} onSelect={set} />;
  }
  const { unmount } = render(<Fixture />);
  const computer = screen.getByRole("tab", { name: "Computer" });
  expect(computer.tabIndex).toBe(0);
  expect(screen.getByRole("tab", { name: "Conversation" }).tabIndex).toBe(-1);
  fireEvent.keyDown(computer, { key: "ArrowRight" });
  const activity = screen.getByRole("tab", { name: "Activity" });
  expect(activity.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(activity);
  fireEvent.keyDown(activity, { key: "ArrowRight" });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Conversation" }));
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
  expect(document.activeElement).toBe(activity);
  fireEvent.keyDown(activity, { key: "Home" });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Conversation" }));
  unmount();
});
it("keeps attention on the conversation tab without stealing focus", () => {
  const { unmount } = render(
    <PaneTabs selected="activity" onSelect={() => {}} attention="conversation" />,
  );
  const tab = screen.getByRole("tab", { name: "Conversation, needs your attention" });
  expect(tab.getAttribute("aria-selected")).toBe("false");
  expect(document.activeElement).not.toBe(tab);
  unmount();
});
it("marks only the pane that needs the user", () => {
  const { container, unmount } = render(
    <PaneTabs selected="conversation" onSelect={() => {}} attention="computer" />,
  );
  expect(screen.getByRole("tab", { name: "Computer, needs your attention" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Conversation" })).toBeTruthy();
  expect(container.querySelectorAll(".pane-waiting")).toHaveLength(1);
  expect(
    screen.getByRole("tab", { name: /^Computer/ }).querySelector(".pane-waiting"),
  ).toBeTruthy();
  unmount();
});
