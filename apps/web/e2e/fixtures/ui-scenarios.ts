export type CellKind =
  | "none"
  | "starting"
  | "connecting"
  | "live"
  | "reconnecting"
  | "paused"
  | "stopped"
  | "failed"
  | "fenced"
  | "fresh-start";

export type ScenarioStep =
  | "approval"
  | "ask"
  | "takeover"
  | "budget"
  | "finish"
  | `cell/${Exclude<CellKind, "none">}`;

export interface UiScenario {
  about: string;
  // QA_* settings the fixture boots with; an explicit QA_* variable still wins.
  boot?: Record<string, string>;
  // What `POST /__qa/scenario/<name>` does on a running fixture.
  step?: ScenarioStep;
  // A fixture booted into the scenario also takes `step` once it is up, for a state its boot
  // settings cannot set.
  stepAtBoot?: true;
}

const FRESH = { QA_CELL: "none", QA_SESSION: "0", QA_REPLAYS: "0" };

export const UI_SCENARIOS = {
  "first-run": {
    about: "No model chosen and no computer yet",
    boot: { ...FRESH, QA_SETTINGS: "empty", QA_KEYS: "0" },
  },
  "model-ready": { about: "A model is chosen; the computer was never started", boot: FRESH },
  starting: {
    about: "The computer is starting",
    boot: { QA_CELL: "starting", QA_SESSION: "0" },
    step: "cell/starting",
  },
  ready: { about: "The computer is on with no task", boot: { QA_SESSION: "0" }, step: "cell/live" },
  "chatgpt-plan": {
    about: "The main model runs on a signed-in ChatGPT plan; the computer is on with no task",
    boot: { QA_SESSION: "0", QA_SETTINGS: "chatgpt", QA_CHATGPT: "signed_in" },
    step: "cell/live",
  },
  running: { about: "dot is working on the sample task" },
  approval: {
    about: "dot waits for a decision before sending",
    step: "approval",
    stepAtBoot: true,
  },
  ask: { about: "dot asks a question", step: "ask", stepAtBoot: true },
  takeover: { about: "dot hands control over for a sign-in", step: "takeover", stepAtBoot: true },
  budget: { about: "The task stopped at its spending limit", step: "budget", stepAtBoot: true },
  done: {
    about: "The task finished with two files",
    boot: { QA_PHASE: "finished" },
    step: "finish",
  },
  continued: {
    about: "The finished task continues an earlier one in the same conversation",
    boot: { QA_PHASE: "finished", QA_EARLIER: "1" },
  },
  reconnecting: {
    about: "The picture stalled while the task runs",
    boot: { QA_CELL: "reconnecting" },
    step: "cell/reconnecting",
  },
  paused: {
    about: "The computer is paused",
    boot: { QA_CELL: "paused" },
    step: "cell/paused",
  },
  failed: {
    about: "The computer failed to start",
    boot: { QA_CELL: "failed", QA_SESSION: "0" },
    step: "cell/failed",
  },
  fenced: {
    about: "The computer needs recovery",
    boot: { QA_CELL: "fenced" },
    step: "cell/fenced",
  },
  "fresh-start": {
    about: "An update that can't be finished leaves the computer needing a fresh start",
    boot: { QA_CELL: "fresh-start", QA_SESSION: "0" },
    step: "cell/fresh-start",
  },
  off: {
    about: "The computer is turned off",
    boot: { QA_CELL: "stopped", QA_SESSION: "0" },
    step: "cell/stopped",
  },
} satisfies Record<string, UiScenario>;

export type UiScenarioName = keyof typeof UI_SCENARIOS;

export function uiScenario(name: string): UiScenario {
  const scenario = (UI_SCENARIOS as Record<string, UiScenario>)[name];
  if (!scenario)
    throw new Error(`Unknown scenario ${name}: ${Object.keys(UI_SCENARIOS).join(", ")}`);
  return scenario;
}

// The step a fixture booted into `scenario` takes once it is up.
export function bootStep(scenario: UiScenario | undefined): ScenarioStep | undefined {
  return scenario?.stepAtBoot ? scenario.step : undefined;
}
