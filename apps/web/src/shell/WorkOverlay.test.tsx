// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type AgentStep, emptyAgentModel } from "../agent/model.ts";
import { WorkOverlay } from "./WorkOverlay.tsx";
import {
  readWorkLayout,
  requestShowCommands,
  WORK_LAYOUT_KEY,
  workTranscript,
} from "./work-overlay.ts";

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
  vi.useRealTimers();
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
  expect(screen.getByRole("button", { name: "Move command window" }).textContent).toBe("WorkLive");
  expect(document.querySelector("iframe, canvas")).toBeNull();
});
it("has no minimized chip and stays under explicit menu control", () => {
  const view = render(<WorkOverlay model={model()} working />);
  expect(screen.queryByRole("button", { name: "Minimize command window" })).toBeNull();
  const browser = model();
  browser.steps.set("two", step("two", "browser"));
  view.rerender(<WorkOverlay model={browser} working={false} />);
  expect(screen.getByRole("region", { name: "Recent command output" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide commands" }));
  expect(screen.queryByRole("region", { name: "Background work" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Show commands" })).toBeNull();
  act(() => requestShowCommands());
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
  expect(readWorkLayout()).toEqual({ x: 1, y: 0, minimized: true, hidden: true });
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
  act(() => requestShowCommands());
  expect(screen.getByRole("region", { name: "Recent command output" })).toBeTruthy();
  expect(readWorkLayout().hidden).toBe(false);
});

it("migrates a previously minimized window to hidden without leaving a floating control", () => {
  localStorage.setItem(WORK_LAYOUT_KEY, JSON.stringify({ x: 0, y: 1, minimized: true }));
  render(<WorkOverlay model={model()} working />);
  expect(screen.queryByRole("region", { name: "Background work" })).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  act(() => requestShowCommands());
  expect(readWorkLayout().minimized).toBe(false);
  expect(screen.getByRole("region", { name: "Recent command output" })).toBeTruthy();
});
