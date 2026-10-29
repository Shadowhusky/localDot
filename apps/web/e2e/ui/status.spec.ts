import { UI_SCENARIOS, type UiScenarioName } from "../fixtures/ui-scenarios.ts";
import { expect, isPhone, test } from "./harness.ts";

// The status model's verdict for each scenario, read where people see it: the island's shape, its
// first control and its label, the stage's light and the tab title. The control comes first: a
// task's controls show its feed has arrived, so a label the task could still replace is final. Under
// a curtain the island is hidden and offers nothing; the curtain holds the one thing to do. While
// the computer is yours, a phone keeps Hand back and Pause in its toolbar, so Stop leads its island.
const STATUS: Record<
  UiScenarioName,
  {
    shape: string;
    control?: RegExp;
    phoneControl?: RegExp;
    label: string;
    light?: "dot" | "you";
    curtain?: string;
  }
> = {
  "first-run": { shape: "hidden", label: "No computer", curtain: "Turn on" },
  "model-ready": { shape: "hidden", label: "No computer", curtain: "Turn on" },
  starting: { shape: "hidden", label: "Starting…" },
  ready: { shape: "ready", control: /^Take control$/, label: "Ready" },
  "slow-keys": { shape: "ready", control: /^Take control$/, label: "Ready" },
  conversations: { shape: "ready", control: /^Take control$/, label: "Done" },
  "chatgpt-plan": { shape: "ready", control: /^Take control$/, label: "Ready" },
  "plan-usage": { shape: "ready", control: /^Take control$/, label: "Ready" },
  running: { shape: "task", control: /^Stop$/, label: "Select the Net total cell", light: "dot" },
  library: { shape: "task", control: /^Stop$/, label: "Select the Net total cell", light: "dot" },
  // dot keeps the computer while it waits on an OK or an answer, so the rim keeps its light.
  approval: { shape: "task", control: /^Stop$/, label: "Needs your OK", light: "dot" },
  ask: { shape: "task", control: /^Stop$/, label: "Needs your answer", light: "dot" },
  // dot's hand-off puts the computer in your hands at once.
  takeover: {
    shape: "control",
    control: /^Stop$/,
    phoneControl: /^Stop$/,
    label: "You're in control",
    light: "you",
  },
  budget: { shape: "task", control: /^(Stop|Continue)$/, label: "Spending limit reached" },
  "keys-locked": {
    shape: "task",
    control: /^Stop$/,
    label: "Select the Net total cell",
    light: "dot",
  },
  "image-output": { shape: "ready", control: /^Take control$/, label: "Done" },
  done: { shape: "ready", control: /^Take control$/, label: "Done" },
  continued: { shape: "ready", control: /^Take control$/, label: "Done" },
  // The last picture holds still and the island says why.
  reconnecting: { shape: "task", control: /^Stop$/, label: "Reconnecting…", light: "dot" },
  paused: { shape: "computer", control: /^Resume$/, label: "Paused" },
  failed: { shape: "hidden", label: "Failed", curtain: "Start again" },
  // A computer that can't carry the task outranks it.
  fenced: { shape: "hidden", label: "Unavailable", curtain: "Replace computer" },
  "fresh-start": { shape: "hidden", label: "Failed", curtain: "Start fresh" },
  off: { shape: "hidden", label: "Stopped", curtain: "Turn on" },
};

test.beforeEach(() => {
  test.skip(!["c14", "w39"].includes(test.info().project.name), "One check per engine");
});

for (const scenario of Object.keys(UI_SCENARIOS) as UiScenarioName[])
  test(`status ${scenario}`, async ({ page, ui }) => {
    const { shape, control, phoneControl, label, light, curtain } = STATUS[scenario];
    await ui.open(scenario);
    const island = page.locator(".island");
    await expect(island).toHaveAttribute("data-shape", shape);
    const first = (isPhone(page) && phoneControl) || control;
    if (first) await expect(island.getByRole("button").first()).toHaveAccessibleName(first);
    else await expect(island.getByRole("button")).toHaveCount(0);
    if (curtain)
      await expect(
        page.locator(".curtain").getByRole("button", { name: curtain, exact: true }),
      ).toBeVisible();
    await expect(page.getByTestId("hud-status")).toHaveText(label);
    await expect(page.locator(".stage-frame")).toHaveAttribute("data-light", light ?? "none");
    await expect(page).toHaveTitle(`localDot — ${label}`);
  });

test("the island keeps its controls as dot moves between states", async ({ page, ui }) => {
  await ui.open("running");
  const stop = page.locator(".island").getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  const before = await stop.elementHandle();
  for (const step of ["ask", "approval"] as const) {
    await ui.step(step);
    await expect(page.locator(".island"), step).toHaveAttribute("data-shape", "task");
    expect(await stop.evaluate((element, first) => element === first, before), step).toBe(true);
  }
});
