import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { UI_SCENARIOS, type UiScenarioName } from "../fixtures/ui-scenarios.ts";
import { expect, test } from "./harness.ts";

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
  "chatgpt-plan": hud("Ready"),
  running: hud("Select the Net total cell"),
  approval: shows((page) => page.getByRole("dialog", { name: "Send this email?" })),
  ask: hud("Needs your answer"),
  takeover: hud("Your turn"),
  budget: hud("Paused · Limit reached"),
  done: hud("Done"),
  continued: hud("Done"),
  reconnecting: shows((page) => page.locator(".stage-veil.on")),
  paused: hud("Paused"),
  failed: hud("Failed"),
  fenced: shows((page) =>
    page
      .getByRole("region", { name: "Computer recovery" })
      .getByRole("heading", { name: "This computer is unavailable", exact: true }),
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(
    settings.getByRole("region", { name: "Main model" }).getByRole("combobox", { name: "Model" }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Close settings" }).click();
  await page.getByTestId("keys-button").click();
  const keys = page.getByRole("dialog", { name: "Keys" });
  await expect(keys.getByText("openai-fast")).toBeVisible();
  await keys.getByRole("button", { name: "Close keys" }).click();
  await expect(keys).toBeHidden();
});

test("Replay opens a recording", async ({ page, ui }) => {
  await ui.open("ready", (fixture) => `/?replay=${fixture.seeded[1]}`);
  await expect(page.getByRole("status", { name: "Replay time" })).toHaveText("0:00 / 1:00");
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
