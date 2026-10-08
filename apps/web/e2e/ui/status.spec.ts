import { UI_SCENARIOS, type UiScenarioName } from "../fixtures/ui-scenarios.ts";
import { expect, test } from "./harness.ts";

// The status model's verdict for each scenario, read where people see it: the HUD label, dot's
// pose in the HUD badge, the xenon rim and the tab title.
const STATUS: Record<UiScenarioName, { label: string; pose: string; control?: true }> = {
  "first-run": { label: "No computer", pose: "sleeping" },
  "model-ready": { label: "No computer", pose: "sleeping" },
  starting: { label: "Starting…", pose: "waking" },
  ready: { label: "Live", pose: "idle" },
  running: { label: "Select the Net total cell", pose: "acting", control: true },
  approval: { label: "Needs your OK", pose: "waiting" },
  ask: { label: "Has a question", pose: "waiting" },
  takeover: { label: "Your turn", pose: "your-turn" },
  budget: { label: "Paused · Limit reached", pose: "resting" },
  done: { label: "Done", pose: "idle" },
  reconnecting: { label: "Select the Net total cell", pose: "acting", control: true },
  paused: { label: "Paused", pose: "resting" },
  failed: { label: "Failed", pose: "error" },
  // The task outranks a fenced computer, but dot holds no control over it.
  fenced: { label: "Select the Net total cell", pose: "acting" },
  off: { label: "Stopped", pose: "sleeping" },
};

test.beforeEach(() => {
  test.skip(!["c14", "w39"].includes(test.info().project.name), "One check per engine");
});

for (const scenario of Object.keys(UI_SCENARIOS) as UiScenarioName[])
  test(`status ${scenario}`, async ({ page, ui }) => {
    const { label, pose, control } = STATUS[scenario];
    await ui.open(scenario);
    await expect(page.getByTestId("hud-status")).toHaveText(label);
    await expect(page.locator(".hud .mascot")).toHaveAttribute("data-state", pose);
    await expect(page.locator(".hud .mascot > .dot")).toHaveCount(1);
    await expect(page.locator(".app")).toHaveClass(control ? /\bcontrol\b/ : /^app$/);
    await expect(page).toHaveTitle(`localDot — ${label}`);
  });

test("dot's badge follows the task as it moves between states", async ({ page, ui }) => {
  await ui.open("running");
  const badge = page.locator(".hud .mascot");
  await expect(badge).toHaveAttribute("data-state", "acting");
  for (const [step, pose] of [
    ["ask", "waiting"],
    ["paused", "resting"],
    ["ready", "waiting"],
  ] as const) {
    await ui.step(step);
    await expect(badge, step).toHaveAttribute("data-state", pose);
  }
});
