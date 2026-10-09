// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { CSSProperties } from "react";
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

it("drops a decision under the ring on a field dot will fill, and hangs it back once answered", () => {
  const box = (element: Element, sizes: Record<string, number>) =>
    Object.entries(sizes).find(([name]) => element.classList.contains(name))?.[1] ?? 0;
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return box(this, { "island-row": 487 });
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return box(this, { "island-row": 40, "island-card": 300 });
  });
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return box(this, { "stage-box": 1024 });
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return box(this, { "stage-box": 640 });
  });
  try {
    const fields = {
      screen: { w: 2560, h: 1600 },
      marks: [
        {
          screen: "desktop" as const,
          point: { x: 1280, y: 760 },
          bbox: { x: 1040, y: 732, w: 480, h: 56 },
        },
      ],
    };
    const asking = props({ status: status("question", "Needs your answer", 2) });
    const gap = { "--island-gap": "8px" } as CSSProperties;
    const view = render(
      <div className="stage-box" style={gap}>
        <HudIsland {...asking} fields={fields} decision={<p>Sign in to your mail</p>} />
      </div>,
    );
    const anchor = document.querySelector<HTMLElement>(".island-anchor");
    // The ring's foot is 324.2 px down the stage; the decision's top goes 12 under it, from -50: the
    // island 40 and its gap 8 over the stage, and the header's 2.
    expect(Number.parseFloat(anchor?.style.getPropertyValue("--_lower") ?? "")).toBeCloseTo(
      386.2,
      6,
    );
    view.rerender(
      <div className="stage-box" style={gap}>
        <HudIsland {...asking} fields={fields} />
      </div>,
    );
    expect(anchor?.style.getPropertyValue("--_lower")).toBe("");
  } finally {
    vi.restoreAllMocks();
  }
});

it("shrinks to the full screen shape, with Take control as an icon and a way out", () => {
  const onExitFull = vi.fn();
  const view = render(<HudIsland {...props({ full: true, onExitFull })} />);
  const anchor = document.querySelector(".island-anchor");
  expect(anchor?.hasAttribute("data-full")).toBe(true);
  const take = screen.getByRole("button", { name: "Take control" });
  expect(take.classList.contains("ui-icon-button")).toBe(true);
  expect(take.textContent).toBe("");
  for (const name of ["Pause", "Stop"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  screen.getByRole("button", { name: "Exit full screen" }).click();
  expect(onExitFull).toHaveBeenCalledOnce();

  view.rerender(
    <HudIsland
      {...props({
        full: true,
        shape: "control",
        status: status("control", "You're in control"),
        onExitFull,
      })}
    />,
  );
  expect(screen.getByRole("button", { name: "Hand back" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Exit full screen" })).toBeTruthy();

  view.rerender(<HudIsland {...props()} />);
  expect(screen.queryByRole("button", { name: "Exit full screen" })).toBeNull();
  expect(screen.getByRole("button", { name: "Take control" }).textContent).toContain(
    "Take control",
  );
});

it("offers Not now beside Hand back while the user holds the computer dot handed over", () => {
  const onDecline = vi.fn();
  const view = render(
    <HudIsland
      {...props({
        shape: "control",
        status: status("control", "You're in control"),
        onDecline,
      })}
    />,
  );
  expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  view.rerender(
    <HudIsland
      {...props({
        shape: "control",
        status: status("control", "You're in control"),
        decline: {},
        onDecline,
      })}
    />,
  );
  const buttons = screen.getAllByRole("button").map((button) => button.textContent);
  expect(buttons.slice(-2)).toEqual(["Not now", "Hand back"]);
  screen.getByRole("button", { name: "Not now" }).click();
  expect(onDecline).toHaveBeenCalledOnce();
});

it("rises over a sheet's scrim while it is up, and settles back as the sheet closes", async () => {
  render(<HudIsland {...props()} />);
  const anchor = document.querySelector(".island-anchor");
  const frame = () => new Promise((done) => requestAnimationFrame(done));
  await frame();
  expect(anchor?.hasAttribute("data-lifted")).toBe(false);
  const layer = document.createElement("div");
  layer.className = "ui-layer";
  layer.innerHTML = '<div class="ui-scrim"></div><div class="ui-sheet"></div>';
  document.body.append(layer);
  await frame();
  await frame();
  expect(anchor?.hasAttribute("data-lifted")).toBe(true);
  layer.setAttribute("data-closing", "");
  await frame();
  await frame();
  expect(anchor?.hasAttribute("data-lifted")).toBe(false);
  layer.remove();
});
