// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hudFor } from "../cells/hud-state.ts";
import type { CellSummary } from "../cells/types.ts";
import { type StatusInput, statusFor, type TaskHud } from "../session/status.ts";
import { Hud } from "./Hud.tsx";

afterEach(cleanup);

const cell: CellSummary = {
  id: "01JXYZ0000000000000000ABCD",
  state: "ready",
  scale: 2,
  createdAt: "",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: null },
};
const live = hudFor({ cell, status: "known", pending: null });
const task = (row: TaskHud["row"], label: string, control = false): TaskHud => ({
  row,
  phase: "running",
  label,
  caption: label,
  elapsedS: 7,
  control,
});
const handlers = () => ({
  onStart: vi.fn(),
  onStop: vi.fn(),
  onStopSession: vi.fn(),
  onResume: vi.fn(),
  onRetry: vi.fn(),
});
const status = (input: Partial<StatusInput>) => statusFor({ computer: live, task: null, ...input });

describe("paused HUD", () => {
  it("offers Resume and Stop, keeps focus through pending changes, and blocks repeated actions", () => {
    const frozen = hudFor({ cell: { ...cell, paused: true }, status: "known", pending: null });
    const props = { ...handlers(), status: status({ computer: frozen }) };
    const view = render(<Hud {...props} />);
    const resume = screen.getByRole("button", { name: "Resume computer" });
    const stop = screen.getByRole("button", { name: "Stop computer" });
    fireEvent.click(resume);
    fireEvent.click(stop);
    expect(props.onResume).toHaveBeenCalledOnce();
    expect(props.onStop).toHaveBeenCalledOnce();
    resume.focus();
    view.rerender(
      <Hud
        {...props}
        status={status({ computer: { ...frozen, action: { kind: "resume", enabled: false } } })}
      />,
    );
    expect(document.activeElement).toBe(resume);
    expect(resume.getAttribute("aria-disabled")).toBe("true");
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(resume);
    fireEvent.click(stop);
    expect(props.onResume).toHaveBeenCalledOnce();
    expect(props.onStop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  });
});

describe("HUD on the status model", () => {
  it("stops the task while one runs, and says so while the Stop is out", () => {
    const props = { ...handlers(), status: status({ task: task("acting", "Typing", true) }) };
    const view = render(<Hud {...props} />);
    expect(screen.getByTestId("hud-status").textContent).toBe("Typing");
    expect(screen.getByTestId("hud-elapsed").textContent).toBe("7 s");
    const stop = screen.getByTestId("hud-stop-session");
    expect(stop.textContent).toBe("Stop");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(stop);
    expect(props.onStopSession).toHaveBeenCalledOnce();
    stop.focus();
    view.rerender(
      <Hud {...props} status={status({ task: task("acting", "Typing"), stop: "stopping" })} />,
    );
    expect(screen.getByTestId("hud-status").textContent).toBe("Stopping…");
    expect(stop.textContent).toBe("Stopping…");
    expect(stop.getAttribute("aria-busy")).toBe("true");
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(stop);
    expect(props.onStopSession).toHaveBeenCalledOnce();
    // Once the task is over, the same control is the computer's own and keeps focus.
    view.rerender(<Hud {...props} status={status({})} />);
    expect(document.activeElement).toBe(stop);
    expect(stop.textContent).toBe("Stop computer");
    expect(stop.dataset.testid).toBeUndefined();
    fireEvent.click(stop);
    expect(props.onStop).toHaveBeenCalledOnce();
  });

  it("feeds dot's badge the pose and rim the status model picks", () => {
    const props = handlers();
    const view = render(
      <Hud {...props} status={status({ task: task("acting", "Typing", true) })} />,
    );
    const badge = () => view.container.querySelector(".hud .mascot");
    expect(badge()?.getAttribute("data-state")).toBe("acting");
    expect(badge()?.querySelector(".dot")).not.toBeNull();
    for (const [row, pose] of [
      ["question", "waiting"],
      ["takeover", "your-turn"],
      ["thinking", "thinking"],
      ["recovery", "resting"],
    ] as const) {
      view.rerender(<Hud {...props} status={status({ task: task(row, row) })} />);
      expect(badge()?.getAttribute("data-state"), row).toBe(pose);
    }
    view.rerender(
      <Hud
        {...props}
        status={status({ computer: hudFor({ cell: null, status: "known", pending: null }) })}
      />,
    );
    expect(badge()?.getAttribute("data-state")).toBe("sleeping");
  });
});
