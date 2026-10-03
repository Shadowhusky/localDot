// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityDetails } from "./ActivityDetails.tsx";
import { DIFF_LIMITS, DiffViewer, diffPreview } from "./DiffViewer.tsx";
import { type AgentChange, type AgentStep, emptyAgentModel } from "./model.ts";
import { TerminalViewer } from "./TerminalViewer.tsx";
import { appendTerminal, emptyTerminal } from "./terminal-text.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const step = (): AgentStep => ({
  id: "step",
  tool: { name: "shell", title: "Run report", ok: true, exitCode: 0 },
  output: [],
  outputTruncated: false,
  terminal: appendTerminal(
    appendTerminal(emptyTerminal(), "stdout", "before\x1b]52;c;hidden\x07after"),
    "stderr",
    "failure 中",
  ),
});
const change = (patch?: string): AgentChange => ({
  id: "change",
  type: "file",
  path: '<svg onload="alert(1)">.txt',
  op: "modify",
  patch,
  truncated: false,
});
describe("non-executing output inspection", () => {
  it("copies only displayed stdout without escapes, links or automatic clipboard actions", async () => {
    const write = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText: write } });
    const { container } = render(<TerminalViewer step={step()} />);
    expect(write).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("region", { name: "Standard output" })).getByText("beforeafter"),
    ).toBeTruthy();
    expect(screen.getByText("failure 中")).toBeTruthy();
    expect(container.querySelectorAll("a,iframe,input,textarea")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Copy stdout" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("beforeafter"));
    expect(write.mock.calls[0]?.[0]).not.toContain("hidden");
    expect(write.mock.calls[0]?.[0]).not.toContain("\x1b");
  });
  it.each([undefined, "", "Binary files a/x and b/x differ", "binary\0patch"])(
    "shows missing or binary diff as unavailable, never as no changes (%s)",
    (patch) => {
      const { container } = render(<DiffViewer change={change(patch)} />);
      expect(screen.getByText("No text diff available.")).toBeTruthy();
      expect(container.textContent).not.toContain("No changes");
      expect(container.querySelector("svg")).toBeNull();
    },
  );
  it("preserves hunk and no-final-newline text while never interpreting malicious path/patch", () => {
    const patch = "@@ -1 +1 @@\n-old\n+<img src=x onerror=alert(1)>\n\\ No newline at end of file";
    const { container } = render(<DiffViewer change={change(patch)} />);
    expect(screen.getByLabelText("Unified text diff").textContent).toBe(patch);
    expect(container.querySelectorAll("img,svg,script")).toHaveLength(0);
    expect(container.querySelector(".diff-hunk")).toBeTruthy();
    expect(screen.getByText("Modified file")).toBeTruthy();
  });
  it("bounds a huge single line and a huge number of diff rows, and makes controls visible instead of copying escapes", () => {
    expect(diffPreview("x".repeat(100_000)).text).toHaveLength(DIFF_LIMITS.chars);
    expect(diffPreview("+x\n".repeat(10_000)).lines).toHaveLength(DIFF_LIMITS.lines);
    const preview = diffPreview("+before\x1b]52;c;hidden\x07after");
    expect(preview.text).not.toContain("\x1b");
    expect(preview.text).toContain("␛");
  });
  it("opens lazy detail for the selected source ID, restores its trigger and retires it on another session", () => {
    const model = {
      ...emptyAgentModel(),
      steps: new Map([["step", step()]]),
      changes: [change("+text")],
      activity: "Actual display event",
    };
    const view = render(<ActivityDetails model={model} sessionId="one" />);
    const summary = screen.getByText("Model activity").closest("details");
    expect(summary?.hasAttribute("open")).toBe(false);
    expect(screen.queryByLabelText("Standard output text")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Inspect Run report" });
    fireEvent.click(trigger);
    expect(screen.getByLabelText("Standard output text").textContent).toBe("beforeafter");
    fireEvent.click(screen.getByRole("button", { name: "Close output" }));
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    view.rerender(<ActivityDetails model={model} sessionId="two" />);
    expect(screen.queryByRole("region", { name: "Selected output" })).toBeNull();
  });
});
