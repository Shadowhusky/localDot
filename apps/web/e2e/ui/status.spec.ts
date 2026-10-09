import { UI_SCENARIOS, type UiScenarioName } from "../fixtures/ui-scenarios.ts";
import { expect, test } from "./harness.ts";

// The status model's verdict for each scenario, read where people see it: the HUD's first control,
// its label, dot's pose in the HUD badge, the xenon rim and the tab title. The control comes first:
// a task's Stop shows its feed has arrived, so a label the task could still replace is final.
const STATUS: Record<UiScenarioName, { control: string; label: string; pose: string; rim?: true }> =
  {
    "first-run": { control: "Turn on", label: "No computer", pose: "sleeping" },
    "model-ready": { control: "Turn on", label: "No computer", pose: "sleeping" },
    starting: { control: "Stop computer", label: "Starting…", pose: "waking" },
    ready: { control: "Stop computer", label: "Live", pose: "idle" },
    "chatgpt-plan": { control: "Stop computer", label: "Live", pose: "idle" },
    running: { control: "Stop", label: "Select the Net total cell", pose: "acting", rim: true },
    approval: { control: "Stop", label: "Needs your OK", pose: "waiting" },
    ask: { control: "Stop", label: "Has a question", pose: "waiting" },
    takeover: { control: "Stop", label: "Your turn", pose: "your-turn" },
    budget: { control: "Stop", label: "Reached your spending limit", pose: "waiting" },
    done: { control: "Stop computer", label: "Done", pose: "idle" },
    continued: { control: "Stop computer", label: "Done", pose: "idle" },
    reconnecting: {
      control: "Stop",
      label: "Select the Net total cell",
      pose: "acting",
      rim: true,
    },
    paused: { control: "Resume computer", label: "Paused", pose: "resting" },
    failed: { control: "Turn on", label: "Failed", pose: "error" },
    // A computer that can't carry the task outranks it; the task keeps only its Stop.
    fenced: { control: "Stop", label: "Unavailable", pose: "error" },
    off: { control: "Turn on", label: "Stopped", pose: "sleeping" },
  };

test.beforeEach(() => {
  test.skip(!["c14", "w39"].includes(test.info().project.name), "One check per engine");
});

for (const scenario of Object.keys(UI_SCENARIOS) as UiScenarioName[])
  test(`status ${scenario}`, async ({ page, ui }) => {
    const { control, label, pose, rim } = STATUS[scenario];
    await ui.open(scenario);
    await expect(page.locator(".hud button").first()).toHaveText(control);
    await expect(page.getByTestId("hud-status")).toHaveText(label);
    await expect(page.locator(".hud .mascot")).toHaveAttribute("data-state", pose);
    await expect(page.locator(".hud .mascot > .dot")).toHaveCount(1);
    await expect(page.locator(".app")).toHaveClass(rim ? /\bcontrol\b/ : /^app$/);
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
