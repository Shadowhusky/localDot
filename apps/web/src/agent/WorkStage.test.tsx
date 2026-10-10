// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeChromium } from "../testing/fake-chromium.ts";
import { type AgentStep, emptyAgentModel } from "./model.ts";
import { appendTerminal, emptyTerminal } from "./terminal-text.ts";
import { WorkStage, workStageSteps } from "./WorkStage.tsx";

let restore: () => void;
beforeEach(() => {
  restore = fakeChromium();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  restore();
});
const step = (id: string, kind: AgentStep["kind"], at: number): AgentStep => ({
  id,
  kind,
  startedAt: at,
  output: [],
  outputTruncated: false,
});
it("follows the latest screen or background action, ignoring thinking, with bounded history", () => {
  const steps = new Map(Array.from({ length: 30 }, (_, i) => [`s${i}`, step(`s${i}`, "shell", i)]));
  steps.set("think", step("think", "think", 30));
  expect(workStageSteps(steps).auto).toBe(true);
  expect(workStageSteps(steps).steps).toHaveLength(8);
  steps.set("browser", step("browser", "browser", 31));
  expect(workStageSteps(steps).auto).toBe(false);
  steps.set("file", step("file", "file", 32));
  expect(workStageSteps(steps).auto).toBe(true);
});
it("uses existing output only, persists choice and reveals the computer during human input", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const shell = {
    ...step("s", "shell", 1),
    tool: { name: "shell", title: "Run checks" },
    terminal: appendTerminal(emptyTerminal(), "stdout", "<img src=x>\x1b]52;c;hidden\x07done"),
  };
  const model = { ...emptyAgentModel(), steps: new Map([[shell.id, shell]]) };
  const { rerender, container } = render(<WorkStage owner="task" model={model} available />);
  expect(screen.getByRole("region", { name: "Live work" })).toBeTruthy();
  expect(container.textContent).toContain("<img src=x>done");
  expect(container.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Computer" }));
  expect(screen.queryByRole("region", { name: "Live work" })).toBeNull();
  expect(localStorage.getItem("localdot.stage-view.v1")).toBe("computer");
  fireEvent.click(screen.getByRole("radio", { name: /^Work$/ }));
  rerender(<WorkStage owner="task" model={model} available={false} />);
  expect(screen.queryByRole("region", { name: "Live work" })).toBeNull();
  rerender(<WorkStage owner="task" model={model} available />);
  expect(screen.getByRole("region", { name: "Live work" })).toBeTruthy();
  rerender(<WorkStage owner="new-task" model={emptyAgentModel()} available />);
  expect(container.textContent).not.toContain("Run checks");
  expect(fetch).not.toHaveBeenCalled();
});
