import type { ViewStyle } from "../../src/shell/view-style.ts";
import { openSettings } from "../settings-ui.ts";
import { type Look, walkTheApp } from "./app-walk.ts";
import { type Appearance, wearAppearance } from "./contrast.ts";
import { expect, runAt, test } from "./harness.ts";
import { strayScrollbars } from "./scrollbars.ts";

// Every screen, sheet, dialog and popover the walk reaches, in light and dark: nothing shows a
// scrollbar it has no use for.
runAt("c14", "c39", "w14", "w39");
test.describe.configure({ timeout: 120_000 });

const APPEARANCES: Appearance[] = ["daylight", "graphite"];
const WALKS_IN: Record<string, ViewStyle> = {
  c14: "studio",
  c39: "studio",
  w14: "chat",
  w39: "chat",
};
const chosenView = process.env.QA_SWEEP_VIEW as ViewStyle | undefined;

test.use({
  viewStyle: async ({ browserName: _ }, use, info) =>
    use(chosenView ?? WALKS_IN[info.project.name] ?? "studio"),
  // Playwright's Chromium is told to draw no scrollbars at all.
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  ...(process.env.QA_SWEEP_SIZE
    ? {
        viewport: {
          width: Number(process.env.QA_SWEEP_SIZE.split("x")[0]),
          height: Number(process.env.QA_SWEEP_SIZE.split("x")[1]),
        },
      }
    : {}),
});

const noStray: Look = async (page, ui, state) => {
  await page.waitForTimeout(150);
  await ui.settle();
  for (const appearance of APPEARANCES) {
    await wearAppearance(page, appearance);
    const found = await strayScrollbars(page);
    expect
      .soft(
        found.map((each) => `${each.where} ${each.axis} by ${each.over}: ${each.why}`),
        `${state} in ${appearance}`,
      )
      .toEqual([]);
  }
};

walkTheApp(noStray);

test("the sweep finds what it is there to find", async ({ page, ui }) => {
  await ui.open("ready");
  await page.evaluate(() => {
    const box = (id: string, css: string, inner?: [string, string]) => {
      const node = document.createElement("div");
      node.dataset.probe = id;
      node.style.cssText = `position:fixed;left:0;top:0;width:100px;height:100px;${css}`;
      if (inner) {
        const child = document.createElement("div");
        [child.style.width, child.style.height] = inner;
        node.append(child);
      }
      document.body.append(node);
    };
    box("always", "overflow:scroll");
    box("slight", "overflow:auto", ["auto", "101px"]);
    box("sideways", "overflow:auto", ["300px", "10px"]);
    box("tall", "overflow:auto", ["10px", "300px"]);
    box("none", "overflow:auto;scrollbar-width:none", ["auto", "300px"]);
    const reach = new CSSStyleSheet();
    reach.replaceSync(
      '[data-probe="reach"]::after { content: ""; position: absolute; right: -6px; width: 10px; height: 10px; }',
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, reach];
    box("reach", "overflow:auto");
  });
  const found = await strayScrollbars(page);
  const about = (axis: string, why: RegExp) =>
    found.filter((each) => each.axis === axis && why.test(each.why)).length;
  expect(about("x", /always/), JSON.stringify(found)).toBe(1);
  expect(about("y", /always/), JSON.stringify(found)).toBe(1);
  expect(about("y", /pixel/), JSON.stringify(found)).toBe(1);
  expect(about("x", /sideways/), JSON.stringify(found)).toBe(1);
  expect(about("x", /::before/), JSON.stringify(found)).toBe(1);
  await page.locator("[data-probe]").evaluateAll((nodes) => {
    for (const node of nodes) node.remove();
  });
});

// What the walk has no need to read for its colours, and what only the longest words show.
const LONG_LINK = `https://${"a".repeat(32)}--dot.example.com/_remote/pair#remote=${"b".repeat(64)}&code=${"c".repeat(32)}`;

test("a shared link just made, with a long name, among others", async ({ page, ui }) => {
  const links = [
    {
      id: "old",
      label: `A very long name for a link ${"without-any-spaces-".repeat(6)}`,
      expiresAt: null,
      revoked: false,
      tasks: 2,
      maxTasks: 10,
      taskBudgetUSD: 5,
      replay: false,
      settings: false,
      chooseModel: false,
    },
  ];
  await page.route("**/api/remote-access", (route) =>
    route.fulfill({
      json: {
        supported: true,
        enabled: true,
        state: "online",
        url: "https://device--dot.example.com",
        detail: "",
      },
    }),
  );
  await page.route("**/api/remote-access/links", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { links } });
    const link = {
      ...links[0],
      ...route.request().postDataJSON(),
      id: "new",
      expiresAt: null,
      url: LONG_LINK,
    };
    links.push(link);
    return route.fulfill({ status: 201, json: link });
  });
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Your computer");
  const group = sheet.getByRole("region", { name: "Shared links", exact: true });
  await group.getByRole("textbox", { name: "Link name", exact: true }).fill("Alex");
  await group.getByRole("button", { name: "Create shared link", exact: true }).click();
  await expect(group.getByRole("textbox", { name: "New shared link", exact: true })).toBeVisible();
  await group.getByRole("region", { name: "Existing shared links" }).scrollIntoViewIfNeeded();
  await noStray(page, ui, "shared-links");
  await page.screenshot({ path: test.info().outputPath("shared-links.png") });
  await sheet.getByRole("button", { name: "Privacy details" }).click();
  await noStray(page, ui, "shared-links-privacy");
});

test("long words, links, code and tables in the chat", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  const words = [
    LONG_LINK,
    `\`${"inline-code-".repeat(16)}\``,
    `\`\`\`\n${"const line = 'one very long line of code';".repeat(6)}\n\`\`\``,
    `| ${"column | ".repeat(14)}\n| ${"--- | ".repeat(14)}\n| ${"value | ".repeat(14)}`,
  ].join("\n\n");
  await page.request.post(`${fixture.origin}/__qa/say?text=${encodeURIComponent(words)}`);
  await page.request.post(`${fixture.origin}/__qa/finish?done=1&markdown=1`);
  await expect(page.locator(".thread-work[data-live]")).toHaveCount(0);
  await noStray(page, ui, "long-words");
  await page.screenshot({ path: test.info().outputPath("long-words.png") });
});

test("long words in a conversation's name and its steps", async ({ page, ui }) => {
  const long = `https://example.com/${"a-path-that-does-not-break-".repeat(6)}`;
  await page.route("**/api/conversations", async (route) => {
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    const { conversations, archivedCount } = await reply.json();
    await route.fulfill({
      json: {
        archivedCount,
        conversations: conversations.map((entry: object) => ({ ...entry, title: long })),
      },
    });
  });
  await page.addInitScript(() =>
    localStorage.setItem("localdot.panels.v1", JSON.stringify({ sessions: true })),
  );
  const fixture = await ui.open("conversations-working");
  // A step's label is at most 80 characters.
  const step = long.slice(0, 80);
  const added = await page.request.post(
    `${fixture.origin}/__qa/steps?n=2&label=${encodeURIComponent(step)}`,
  );
  expect(added.ok(), await added.text()).toBe(true);
  await expect(page.getByText(step).first()).toBeVisible();
  await noStray(page, ui, "long-names");
  const row = page.locator(".thread-work-list button.activity-row-head").last();
  if (await row.isVisible()) {
    await row.click();
    await noStray(page, ui, "long-step-open");
    await page.screenshot({ path: test.info().outputPath("long-step.png") });
  }
});

test("what someone with a shared link sees", async ({ page, ui }) => {
  await page.route("**/api/whoami", (route) => route.fulfill({ json: { ok: true, shared: true } }));
  await page.route("**/api/remote-session", (route) =>
    route.fulfill({
      json: {
        id: "fixture",
        label: "Guest",
        model: { provider: "openai", model: "gpt-6.1-sol" },
        models: [],
        tasks: 0,
        maxTasks: 5,
        taskBudgetUSD: 2,
        expiresAt: null,
        settings: false,
        replay: false,
        chooseModel: false,
        ownedSessions: [],
      },
    }),
  );
  await ui.open("ready");
  await expect(page.locator(".app[data-guest]")).toBeVisible();
  await noStray(page, ui, "shared-link");
});

test("what dot knows, with facts, notes and people", async ({ page, ui }) => {
  const fixture = await ui.open("ready");
  await page.request.post(`${fixture.origin}/__qa/knows`);
  const sheet = await openSettings(page, undefined, "What dot knows");
  await expect(sheet.getByText("Allergic to penicillin")).toBeVisible();
  await noStray(page, ui, "knows");
  const raw = sheet.getByRole("button", { name: /^Show (the )?(raw|file)/ });
  if (await raw.count()) {
    await raw.first().click();
    await noStray(page, ui, "knows-raw");
  }
});

test("the form for a new key", async ({ page, ui }) => {
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Keys");
  await sheet.getByRole("button", { name: /^Add (a )?key$/ }).click();
  await expect(sheet.getByRole("form", { name: "Add a key" })).toBeVisible();
  await noStray(page, ui, "key-form");
});

test("what a problem report sends", async ({ page, ui }) => {
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Report a problem");
  const all = sheet.getByRole("button", { name: "Everything that will be sent" });
  await noStray(page, ui, "report");
  if (await all.isVisible()) {
    await all.click();
    await noStray(page, ui, "report-all");
  }
});

for (const step of ["welcome", "key", "model", "permissions", "dot", "browser", "turn-on"])
  test(`setup: ${step}`, async ({ page, ui }) => {
    await page.addInitScript(
      (at) =>
        localStorage.setItem(
          "localdot.onboarding.v1",
          JSON.stringify({ step: at, kind: "api", provider: "anthropic" }),
        ),
      step,
    );
    await ui.open("first-run");
    await expect(page.locator(".app")).toBeVisible();
    await page.waitForTimeout(400);
    await noStray(page, ui, `setup-${step}`);
  });
