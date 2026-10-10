import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { UI_SCENARIOS, type UiScenarioName } from "../fixtures/ui-scenarios.ts";
import { closeSettings, nestedKeys, openSettings } from "../settings-ui.ts";
import { expect, isPhone, test } from "./harness.ts";

// The harness checks itself across the whole matrix: every scenario, sheet and gallery page renders
// what it names, with no page error, CSP violation or outside request (the `ui` fixture fails the
// test on any of those).
const hud = (label: string) => (page: Page) =>
  expect(page.getByTestId("hud-status")).toHaveText(label);
const shows = (find: (page: Page) => Locator) => (page: Page) => expect(find(page)).toBeVisible();
const LANDMARKS: Record<UiScenarioName, (page: Page) => Promise<void>> = {
  "first-run": shows((page) => page.getByRole("heading", { name: "Your computer is off" })),
  "model-ready": hud("No computer"),
  starting: hud("Starting…"),
  ready: hud("Ready"),
  "slow-keys": hud("Ready"),
  conversations: hud("Done"),
  "chatgpt-plan": hud("Ready"),
  running: hud("Select the Net total cell"),
  approval: shows((page) => page.getByRole("dialog", { name: "Send this email?" })),
  ask: hud("Needs your answer"),
  takeover: hud("You're in control"),
  budget: hud("Spending limit reached"),
  done: hud("Done"),
  continued: hud("Done"),
  reconnecting: hud("Reconnecting…"),
  paused: hud("Paused"),
  failed: hud("Failed"),
  fenced: shows((page) =>
    page
      .getByRole("region", { name: "Your computer needs a fresh start" })
      .getByRole("button", { name: "Replace computer" }),
  ),
  "fresh-start": shows((page) =>
    page.getByRole("heading", { name: "Your computer needs a fresh start" }),
  ),
  off: hud("Stopped"),
};

for (const scenario of Object.keys(UI_SCENARIOS) as UiScenarioName[])
  test(`scenario ${scenario}`, async ({ page, ui }) => {
    await ui.open(scenario);
    await LANDMARKS[scenario](page);
    await ui.settle();
  });

test("a running fixture steps between scenarios", async ({ page, ui }) => {
  await ui.open("running");
  await LANDMARKS.running(page);
  await ui.step("paused");
  await LANDMARKS.paused(page);
  // "ready" brings the computer back live, so the task carries on.
  await ui.step("ready");
  await LANDMARKS.running(page);
  await ui.step("done");
  await LANDMARKS.done(page);
});

test("Settings and Keys open", async ({ page, ui }) => {
  await ui.open("ready");
  // From the top bar, or from More on a phone, whose sheet goes into one section at a time.
  const settings = await openSettings(page, undefined, "Models");
  await expect(
    settings.getByRole("region", { name: "Main model" }).getByRole("combobox", { name: "Model" }),
  ).toBeVisible();
  await closeSettings(page);
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Keys", exact: true }).click();
  } else await page.getByTestId("keys-button").click();
  await expect(nestedKeys(page).getByText("openai-fast")).toBeVisible();
  await closeSettings(page);
});

test("Replay opens a recording", async ({ page, ui }) => {
  await ui.open("ready", (fixture) => `/?replay=${fixture.seeded[1]}`);
  await expect(page.getByRole("status", { name: "Replay time" })).toHaveText("0:00");
  await expect(page.locator(".replay-length")).toHaveText("1:00");
  await ui.settle();
});

test("every gallery page renders", async ({ page, ui }) => {
  await ui.gallery("index");
  const pages = await page
    .locator(".gallery-index a")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")?.slice(1) ?? ""));
  expect(pages.length).toBeGreaterThan(0);
  for (const name of pages) await ui.gallery(name);
});

test("the production build carries no gallery code", () => {
  test.skip(test.info().project.name !== "c14", "One check of the build is enough");
  const dist = fileURLToPath(new URL("../../dist", import.meta.url));
  const files = readdirSync(dist, { recursive: true, encoding: "utf8" });
  expect(files.filter((file) => /gallery/i.test(file))).toEqual([]);
  const scripts = files.filter((file) => /\.(js|html)$/.test(file));
  expect(scripts.length).toBeGreaterThan(0);
  for (const file of scripts)
    expect(readFileSync(`${dist}/${file}`, "utf8"), file).not.toContain("data-gallery-page");
});
