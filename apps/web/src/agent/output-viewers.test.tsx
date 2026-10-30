// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIFF_LIMITS, diffPreview } from "../deliverables/viewer/diff.ts";
import { frameCrop } from "./ActivityDetails.tsx";
import { DiffViewer, numberLines } from "./DiffViewer.tsx";
import type { AgentChange, AgentStep } from "./model.ts";
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
      within(screen.getByRole("region", { name: "Output" })).getByText("beforeafter"),
    ).toBeTruthy();
    expect(screen.getByText("failure 中")).toBeTruthy();
    expect(container.querySelectorAll("a,iframe,input,textarea")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Copy output" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("beforeafter"));
    expect(write.mock.calls[0]?.[0]).not.toContain("hidden");
    expect(write.mock.calls[0]?.[0]).not.toContain("\x1b");
  });
  it("adds no tab stops for output and diffs that wrap instead of scrolling", () => {
    const { container } = render(
      <>
        <TerminalViewer step={step()} />
        <DiffViewer change={change("@@ -1 +1 @@\n-old\n+new")} />
      </>,
    );
    expect(container.querySelectorAll("[tabindex]")).toHaveLength(0);
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
    expect(screen.getByText("Changed")).toBeTruthy();
  });
  it("bounds a huge single line and a huge number of diff rows, and makes controls visible instead of copying escapes", () => {
    expect(diffPreview("x".repeat(100_000)).text).toHaveLength(DIFF_LIMITS.chars);
    expect(diffPreview("+x\n".repeat(10_000)).lines).toHaveLength(DIFF_LIMITS.lines);
    const preview = diffPreview("+before\x1b]52;c;hidden\x07after");
    expect(preview.text).not.toContain("\x1b");
    expect(preview.text).toContain("␛");
  });
  it("numbers lines from the hunk headers without putting numbers into the diff text", () => {
    const patch = "@@ -4,3 +4,3 @@\n Month,Net\n-Dec,12000\n+Dec,12311\n Total,12480";
    expect(numberLines(patch.split("\n"))).toEqual([
      { kind: "hunk" },
      { kind: "line", line: 4 },
      { kind: "remove", line: 5 },
      { kind: "add", line: 5 },
      { kind: "line", line: 6 },
    ]);
    render(<DiffViewer change={change(patch)} />);
    const text = screen.getByLabelText("Unified text diff");
    expect(text.textContent).toBe(patch);
    expect(
      [...text.querySelectorAll("[data-line]")].map((row) => row.getAttribute("data-line")),
    ).toEqual(["4", "5", "5", "6"]);
  });
  it("crops a step's frame around its target and keeps the whole frame without one", () => {
    expect(frameCrop(undefined, 2)).toEqual({
      image: { width: "100%", left: "0%", top: "0%" },
      target: null,
    });
    const crop = frameCrop({ x: 1200, y: 800, w: 80, h: 40 }, 2);
    expect(crop.image.width).toBe("400.000%");
    // A 40 × 20 target sits in the middle of a 320 × 200 window, the narrowest one shown.
    expect(crop.target).toEqual({
      left: "43.750%",
      top: "45.000%",
      width: "12.500%",
      height: "10.000%",
    });
  });
});
