import { UI_SCENARIOS, type UiScenarioName } from "../fixtures/ui-scenarios.ts";
import { expect, test } from "./harness.ts";

// The status model's verdict for each scenario, read where people see it: the island's shape, its
// first control and its label, the stage's light and the tab title. The control comes first: a
// task's controls show its feed has arrived, so a label the task could still replace is final. Under
// the first-run curtain the island is hidden and offers nothing.
const STATUS: Record<
  UiScenarioName,
  { shape: string; control?: RegExp; label: string; light?: "dot" }
> = {
  "first-run": { shape: "hidden", label: "No computer" },
  "model-ready": { shape: "hidden", label: "No computer" },
  starting: { shape: "computer", control: /^Shut down$/, label: "Starting…" },
  ready: { shape: "ready", control: /^Take control$/, label: "Ready" },
  "slow-keys": { shape: "ready", control: /^Take control$/, label: "Ready" },
  conversations: { shape: "ready", control: /^Take control$/, label: "Done" },
  "chatgpt-plan": { shape: "ready", control: /^Take control$/, label: "Ready" },
  running: { shape: "task", control: /^Pause$/, label: "Select the Net total cell", light: "dot" },
  // dot keeps the computer while it waits on an OK or an answer, so the rim keeps its light.
  approval: { shape: "task", control: /^Pause$/, label: "Needs your OK", light: "dot" },
  ask: { shape: "task", control: /^Pause$/, label: "Needs your answer", light: "dot" },
  takeover: { shape: "task", control: /^Pause$/, label: "Your turn" },
  budget: { shape: "task", control: /^(Pause|Continue)$/, label: "Spending limit reached" },
  done: { shape: "ready", control: /^Take control$/, label: "Done" },
  continued: { shape: "ready", control: /^Take control$/, label: "Done" },
  reconnecting: {
    shape: "task",
    control: /^Pause$/,
    label: "Select the Net total cell",
    light: "dot",
  },
  paused: { shape: "computer", control: /^Continue$/, label: "Paused" },
  failed: { shape: "computer", control: /^Turn on$/, label: "Failed" },
  // A computer that can't carry the task outranks it; the task keeps only its controls.
  fenced: { shape: "task", control: /^Pause$/, label: "Unavailable" },
  "fresh-start": { shape: "computer", control: /^Turn on$/, label: "Failed" },
  off: { shape: "computer", control: /^Turn on$/, label: "Stopped" },
};

test.beforeEach(() => {
  test.skip(!["c14", "w39"].includes(test.info().project.name), "One check per engine");
});

for (const scenario of Object.keys(UI_SCENARIOS) as UiScenarioName[])
  test(`status ${scenario}`, async ({ page, ui }) => {
    const { shape, control, label, light } = STATUS[scenario];
    await ui.open(scenario);
    const island = page.locator(".island");
    await expect(island).toHaveAttribute("data-shape", shape);
    if (control) await expect(island.getByRole("button").first()).toHaveAccessibleName(control);
    else await expect(island.getByRole("button")).toHaveCount(0);
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
