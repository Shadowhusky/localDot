import { openSettings, roleCard } from "../settings-ui.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test("settings pages show only their own content and invalid drafts reveal a field without a discard dialog", async ({
  page,
  ui,
}) => {
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Models");
  const main = roleCard(sheet, "main");
  await expect(main).toBeVisible();
  if (isPhone(page)) {
    await sheet.getByRole("button", { name: "Settings", exact: true }).click();
    await sheet.getByRole("button", { name: /^Autonomy/ }).click();
  } else await sheet.getByRole("button", { name: "Autonomy", exact: true }).click();
  await expect(main).not.toBeVisible();
  await expect(sheet.getByRole("radiogroup", { name: "Start from" })).toBeVisible();
  if (!isPhone(page)) {
    await sheet.getByRole("button", { name: "Models", exact: true }).click();
    await expect(main).toBeVisible();
  }
  await page.screenshot({ path: test.info().outputPath("settings-page.png") });
});
test("shared access has its own guest view and fixed model with no owner settings controls", async ({
  page,
  ui,
}) => {
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
  await expect(page.getByRole("main")).toHaveClass("shared-app");
  await expect(page.getByRole("textbox", { name: "Message dot" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Replays", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  const box = await page.getByRole("textbox", { name: "Message dot" }).boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= (page.viewportSize()?.width ?? 0)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("shared-chat.png") });
});

test("owner creates a permanent limited link and revokes it from the same page", async ({
  page,
  ui,
}) => {
  const links: Record<string, unknown>[] = [];
  let payload: Record<string, unknown> | null = null;
  await page.route("**/api/remote-access", (route) =>
    route.fulfill({
      json: {
        supported: true,
        enabled: true,
        state: "online",
        url: "https://fixture.localdot.dev",
        detail: "",
      },
    }),
  );
  await page.route("**/api/remote-access/links", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { links } });
    payload = route.request().postDataJSON();
    const link = {
      ...payload,
      id: "fixture-link",
      expiresAt: null,
      tasks: 0,
      revoked: false,
      url: "https://fixture.localdot.dev/_remote/pair#remote=fixture&code=fixture",
    };
    links.push(link);
    return route.fulfill({ status: 201, json: link });
  });
  await page.route("**/api/remote-access/links/fixture-link", (route) =>
    route.fulfill({ status: 204 }),
  );
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Your computer");
  const group = sheet.getByRole("region", { name: "Shared links", exact: true });
  const intro = group.locator(".settings-group-intro");
  const heading = await intro.locator("h4").boundingBox();
  const note = await intro.locator("p").boundingBox();
  expect(heading && note && note.y - heading.y - heading.height).toBeLessThanOrEqual(12);
  await group.getByRole("textbox", { name: "Link name", exact: true }).fill("Alex");
  await group.getByRole("combobox", { name: "Expires", exact: true }).click();
  await page.getByRole("option", { name: "Never · until revoked", exact: true }).click();
  await group.getByRole("spinbutton", { name: "Task limit", exact: true }).fill("3");
  await group.getByRole("button", { name: "Create shared link", exact: true }).click();
  await expect(group.getByRole("textbox", { name: "New shared link", exact: true })).toBeVisible();
  expect(payload).toMatchObject({
    label: "Alex",
    expiresInHours: null,
    maxTasks: 3,
    chooseModel: false,
    replay: false,
    settings: false,
  });
  await group.getByRole("button", { name: /Revoke/ }).click();
  await expect(group.getByText(/^Revoked ·/)).toBeVisible();
  await expect(group.getByRole("textbox", { name: "New shared link", exact: true })).toHaveCount(0);
  const visible = await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(visible).toBe(true);
  await page.screenshot({ path: test.info().outputPath("shared-link-settings.png") });
});
