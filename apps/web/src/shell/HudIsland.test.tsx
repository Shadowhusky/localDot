// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Status, StatusRow } from "../session/status.ts";
import { HudIsland, type HudIslandProps } from "./HudIsland.tsx";

afterEach(cleanup);

const status = (row: StatusRow, label: string, elapsedS: number | null = 42): Status => ({
  row,
  computer: "live",
  label,
  caption: { speaker: "dot", text: "" },
  elapsedS,
  countdownS: null,
  actions: [{ kind: "stop-task", enabled: true }],
  control: true,
  dotPose: "acting",
  attention: "working",
  title: `localDot — ${label}`,
});
const props = (over: Partial<HudIslandProps> = {}): HudIslandProps => ({
  status: status("acting", "Selecting February's net total"),
  shape: "task",
  pause: { kind: "pause" },
  take: { primary: false, reason: "dot hands you the computer when it needs you" },
  onPause: vi.fn(),
  onContinue: vi.fn(),
  onStopTask: vi.fn(),
  onTake: vi.fn(),
  onComputer: { start: vi.fn(), stop: vi.fn(), resume: vi.fn(), retry: vi.fn() },
  ...over,
});

it("reads a task over an hour as h:mm:ss, never as seconds", () => {
  const view = render(<HudIsland {...props({ status: status("acting", "Working", 3665) })} />);
  expect(screen.getByTestId("hud-elapsed").textContent).toBe("1:01:05");
  view.rerender(<HudIsland {...props({ status: status("acting", "Working", 42) })} />);
  expect(screen.getByTestId("hud-elapsed").textContent).toBe("0:42");
  expect(document.body.textContent).not.toMatch(/\d+ s\b/);
});

it("counts down to a model retry in the elapsed slot", () => {
  render(
    <HudIsland
      {...props({
        status: { ...status("retrying", "Model busy · retrying", null), countdownS: 20 },
      })}
    />,
  );
  expect(screen.getByTestId("hud-elapsed").textContent).toBe("in 20 s");
});

it("keeps Pause, Stop and Take control in place as dot thinks, acts and checks the screen", () => {
  const view = render(<HudIsland {...props({ status: status("thinking", "Thinking") })} />);
  const controls = () =>
    ["Pause", "Stop", "Take control"].map((name) => screen.getByRole("button", { name }));
  const first = controls();
  for (const [row, label] of [
    ["acting", "Selecting February's net total"],
    ["observing", "Checking the screen"],
    ["thinking", "Thinking"],
  ] as const) {
    view.rerender(<HudIsland {...props({ status: status(row, label) })} />);
    expect(controls(), row).toEqual(first);
    expect(document.querySelector(".island")?.getAttribute("data-shape")).toBe("task");
    expect(screen.getByRole("button", { name: "Pause" }).getAttribute("aria-disabled")).toBeNull();
  }
});

it("shows only the label and Take control while ready, and makes Take control porcelain when dot hands over", () => {
  const view = render(
    <HudIsland
      {...props({
        shape: "ready",
        status: { ...status("ready", "Ready", null), actions: [{ kind: "stop", enabled: true }] },
      })}
    />,
  );
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  const take = screen.getByRole("button", { name: "Take control" });
  expect(take.getAttribute("aria-disabled")).toBe("true");
  const onTake = vi.fn();
  view.rerender(
    <HudIsland
      {...props({
        status: { ...status("takeover", "Your turn", null), attention: "needs_you" },
        take: { primary: true },
        onTake,
      })}
    />,
  );
  const handed = screen.getByRole("button", { name: "Take control" });
  expect(handed.getAttribute("data-variant")).toBe("primary");
  handed.click();
  expect(onTake).toHaveBeenCalledOnce();
  expect(document.querySelector(".island-attention")).toBeTruthy();
});

it("grows into a decision under its own row, so Stop and Take control never move", () => {
  const view = render(
    <HudIsland {...props({ status: status("approval", "Needs your OK", 24) })} />,
  );
  const stop = screen.getByRole("button", { name: "Stop" });
  const take = screen.getByRole("button", { name: "Take control" });
  view.rerender(
    <HudIsland
      {...props({ status: status("approval", "Needs your OK", 24) })}
      decision={<p>Send this email?</p>}
      notices={<p className="island-note">Saved</p>}
    />,
  );
  expect(document.querySelector(".island")?.hasAttribute("data-open")).toBe(true);
  expect(screen.getByRole("button", { name: "Stop" })).toBe(stop);
  expect(screen.getByRole("button", { name: "Take control" })).toBe(take);
  expect(document.querySelector(".island-card")?.textContent).toBe("Send this email?");
  expect(document.querySelector(".island-notices")?.textContent).toBe("Saved");
  view.rerender(
    <HudIsland
      {...props({ shape: "ready", status: status("ready", "Ready", null) })}
      decision={<p>Send this email?</p>}
    />,
  );
  expect(document.querySelector(".island")?.hasAttribute("data-open")).toBe(false);
});
