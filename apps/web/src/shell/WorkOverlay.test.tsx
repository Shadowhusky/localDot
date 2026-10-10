// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type AgentStep, emptyAgentModel } from "../agent/model.ts";
import { WorkOverlay } from "./WorkOverlay.tsx";
import { readWorkLayout, WORK_LAYOUT_KEY, workTranscript } from "./work-overlay.ts";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  localStorage.setItem(WORK_LAYOUT_KEY, JSON.stringify({ x: 0, y: 1, minimized: false }));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
const step = (id: string, kind: AgentStep["kind"] = "shell"): AgentStep => ({
  id,
  kind,
  tool: {
    name: kind === "browser" ? "browser_act" : "shell",
    title: "printf 'hello'\nsecond line",
  },
  output: [{ stream: "stdout", text: "hello\n" }],
  outputTruncated: false,
});
const model = () => ({ ...emptyAgentModel(), steps: new Map([["one", step("one")]]) });

it("keeps command output in app DOM and keeps the chrome title on one line", () => {
  render(<WorkOverlay model={model()} working />);
  expect(screen.getByRole("region", { name: "Recent command output" }).textContent).toContain(
    "hello",
  );
  expect(screen.getByRole("button", { name: "Move command window" }).textContent).toBe(
    "Background workLive",
  );
  expect(document.querySelector("iframe, canvas")).toBeNull();
});
it("preserves minimize across output, tool changes and remounts", () => {
  const view = render(<WorkOverlay model={model()} working />);
  fireEvent.click(screen.getByRole("button", { name: "Minimize command window" }));
  const next = model();
  next.steps.set("two", step("two"));
  view.rerender(<WorkOverlay model={next} working />);
  expect(screen.queryByRole("region", { name: "Recent command output" })).toBeNull();
  view.unmount();
  render(<WorkOverlay model={next} working />);
  expect(screen.getByRole("button", { name: "Expand command window" })).toBeTruthy();
  expect(readWorkLayout().minimized).toBe(true);
});
it("collapses for screen interaction and completion without destroying the transcript", () => {
  const view = render(<WorkOverlay model={model()} working />);
  const browser = model();
  browser.steps.set("two", step("two", "browser"));
  view.rerender(<WorkOverlay model={browser} working />);
  expect(screen.queryByRole("region", { name: "Recent command output" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand command window" }));
  expect(screen.getByRole("region", { name: "Recent command output" }).textContent).toContain(
    "hello",
  );
  view.rerender(<WorkOverlay model={model()} working={false} />);
  // An explicit user expansion remains under their control, even when the task finishes.
  expect(screen.getByRole("region", { name: "Recent command output" })).toBeTruthy();
});
it("bounds retained output and strips terminal control sequences", () => {
  const value = model();
  for (let n = 0; n < 20; n++)
    value.steps.set(String(n), {
      ...step(String(n)),
      output: [{ stream: "stdout", text: `\x1b[31m${"x".repeat(3000)}` }],
    });
  const { entries } = workTranscript(value);
  expect(entries).toHaveLength(6);
  expect(entries.map((row) => row.text).join("").length).toBeLessThanOrEqual(12000);
  expect(entries.some((row) => row.text.includes("\x1b"))).toBe(false);
});
it("validates saved positions and allows storage to be unavailable", () => {
  localStorage.setItem(WORK_LAYOUT_KEY, '{"x":20,"y":-4,"minimized":true}');
  expect(readWorkLayout()).toEqual({ x: 1, y: 0, minimized: true, hidden: false });
  localStorage.setItem(WORK_LAYOUT_KEY, "broken");
  expect(readWorkLayout().x).toBe(0.02);
});

it("keeps commands hidden across output and reload, and restores them on request", () => {
  const view = render(<WorkOverlay model={model()} working />);
  fireEvent.click(screen.getByRole("button", { name: "Hide commands" }));
  view.rerender(<WorkOverlay model={model()} working />);
  expect(screen.queryByRole("region", { name: "Background work" })).toBeNull();
  expect(readWorkLayout().hidden).toBe(true);
  view.unmount();
  render(<WorkOverlay model={model()} working />);
  fireEvent.click(screen.getByRole("button", { name: "Show commands" }));
  expect(screen.getByRole("region", { name: "Recent command output" })).toBeTruthy();
  expect(readWorkLayout().hidden).toBe(false);
});
