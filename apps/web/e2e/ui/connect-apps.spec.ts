import type { Locator, Page } from "@playwright/test";
import { openSettings } from "../settings-ui.ts";
import { expect, runAt, test } from "./harness.ts";

// Connecting an app in one click: the real Settings page and the real daemon routes, sign-in flow
// and connector hub, against a sign-in service and a keyd that answer in memory in the fixture. What
// a real browser does at the app's page is what `approve` does: it visits the address the service
// would send the user back to.
runAt("c14", "w14", "c39", "w39");

// The app follows the device's colour mode, so a test can picture it in both.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("localdot.appearance.v1", "system"));
});

interface Connect {
  pages: number;
  page?: string;
  state?: string;
  redirect?: string;
  clientId?: string;
  grants: { id: string; code: string; clientId: string; tokenEndpoint: string }[];
}

const url = (page: Page, path: string) => new URL(path, page.url()).href;
const connectInfo = async (page: Page): Promise<Connect> =>
  (await page.request.get(url(page, "/__qa/connect"))).json() as Promise<Connect>;
const qa = (page: Page, path: string) => page.request.post(url(page, path));

async function approve(page: Page, query = "code=the-code"): Promise<string> {
  const { state, redirect } = await connectInfo(page);
  const tab = await page.context().newPage();
  const reply = await tab.goto(`${redirect}?state=${state}&${query}`);
  const text = (await reply?.text()) ?? "";
  await tab.close();
  return text;
}

async function connectors(
  page: Page,
  ui: { open(s: "ready"): Promise<unknown> },
): Promise<Locator> {
  await ui.open("ready");
  return openSettings(page, undefined, "Connectors");
}

// What the screen looks like. The app crossfades when the colour mode changes, so a run takes its
// pictures in one mode: QA_COLOR=dark for dark.
const colorScheme = process.env.QA_COLOR === "dark" ? "dark" : "light";
test.use({ colorScheme });
const pictures = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}-${colorScheme}.png`) });

const row = (sheet: Locator, name: string) =>
  sheet.locator(".connectors-catalog > li").filter({ hasText: name });
const app = (sheet: Locator, name: string) =>
  sheet.locator(".connectors-app").filter({ hasText: name });

test("one click on Connect, approve in the browser, and the app is connected", async ({
  page,
  ui,
}) => {
  const sheet = await connectors(page, ui);
  // The page is opened by the daemon in the Mac's browser: nothing opens here, and no pop-up.
  const popups: unknown[] = [];
  page.on("popup", (p) => popups.push(p));
  await row(sheet, "Notion").getByRole("button", { name: "Connect", exact: true }).click();
  const card = app(sheet, "Notion");
  await expect(card.getByText("Approve in your browser")).toBeVisible();
  await expect(card.getByText("Waiting for your approval")).toBeVisible();
  await expect.poll(async () => (await connectInfo(page)).pages).toBe(1);
  const info = await connectInfo(page);
  expect(info.page).toContain("https://auth.fake-app.example/authorize");
  expect(info.clientId).toBe("https://localdot.dev/oauth/client-metadata.json");
  expect(info.redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/connectors\/callback$/);
  expect(new URL(info.page ?? "").searchParams.get("code_challenge_method")).toBe("S256");
  expect(popups).toEqual([]);

  expect(await approve(page)).toContain("Connected to Notion");
  await expect(card.getByText("Connected as ada@example.com")).toBeVisible();
  await expect(card.getByText("Waiting for your approval")).toBeHidden();
  await expect(card.getByRole("button", { name: "Reconnect" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Disconnect" })).toBeVisible();
  expect((await connectInfo(page)).grants).toEqual([
    {
      id: "connector-notion",
      code: "the-code",
      clientId: "https://localdot.dev/oauth/client-metadata.json",
      tokenEndpoint: "https://auth.fake-app.example/token",
    },
  ]);
  // Connecting moved it out of the apps to add.
  await expect(row(sheet, "Notion")).toHaveCount(0);
  await ui.settle();
  await pictures(page, "connected");
});

test("disconnecting keeps the app, ready to connect again; reconnecting signs in again", async ({
  page,
  ui,
}) => {
  const sheet = await connectors(page, ui);
  await row(sheet, "Vercel").getByRole("button", { name: "Connect", exact: true }).click();
  const card = app(sheet, "Vercel");
  await expect(card.getByText("Approve in your browser")).toBeVisible();
  await approve(page);
  await expect(card.getByText("Connected as ada@example.com")).toBeVisible();

  await card.getByRole("button", { name: "Reconnect" }).click();
  await expect(card.getByText("Approve in your browser")).toBeVisible();
  await expect.poll(async () => (await connectInfo(page)).pages).toBe(2);
  await approve(page);
  await expect(card.getByText("Connected as ada@example.com")).toBeVisible();

  await card.getByRole("button", { name: "Disconnect" }).click();
  await expect(card.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await expect(card.getByText("Not connected")).toBeVisible();
  await expect(card.getByText("Connected as ada@example.com")).toBeHidden();
});

test("a sign-in that ended asks to reconnect, not fail silently", async ({ page, ui }) => {
  const sheet = await connectors(page, ui);
  await row(sheet, "Canva").getByRole("button", { name: "Connect", exact: true }).click();
  const card = app(sheet, "Canva");
  await expect(card.getByText("Approve in your browser")).toBeVisible();
  await approve(page);
  await expect(card.getByText("Connected as ada@example.com")).toBeVisible();
  await qa(page, "/__qa/connect/ended?id=connector-canva");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(card.getByText("Needs reconnecting")).toBeVisible();
  await expect(card.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await expect(card.getByText("Its sign-in has ended")).toBeVisible();
  await ui.settle();
  await pictures(page, "ended");
});

test("from another device it says where to finish, and that it can't be finished here", async ({
  page,
  ui,
}) => {
  const sheet = await connectors(page, ui);
  await qa(page, "/__qa/connect?remote=1");
  await row(sheet, "Notion").getByRole("button", { name: "Connect", exact: true }).click();
  const card = app(sheet, "Notion");
  await expect(card.getByText("Finish on your Mac")).toBeVisible();
  await expect(card.getByText("It can't be finished from this device.")).toBeVisible();
  await expect.poll(async () => (await connectInfo(page)).pages).toBe(1);
  await ui.settle();
  await pictures(page, "remote");
  // Approved at the Mac, the phone just sees it connected.
  await approve(page);
  await expect(card.getByText("Connected as ada@example.com")).toBeVisible();
});

test("cancelling, or turning it down at the app, leaves it to be tried again", async ({
  page,
  ui,
}) => {
  const sheet = await connectors(page, ui);
  await row(sheet, "Notion").getByRole("button", { name: "Connect", exact: true }).click();
  const card = app(sheet, "Notion");
  await expect(card.getByText("Approve in your browser")).toBeVisible();
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByRole("button", { name: "Connect", exact: true })).toBeVisible();

  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(card.getByText("Approve in your browser")).toBeVisible();
  await expect.poll(async () => (await connectInfo(page)).pages).toBe(2);
  expect(await approve(page, "error=access_denied")).toContain("Not connected");
  await expect(card.getByText("The sign-in wasn't approved")).toBeVisible();
  await expect(card.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
});

test("with no browser to open, this browser gets the page's address", async ({ page, ui }) => {
  const sheet = await connectors(page, ui);
  await qa(page, "/__qa/connect?opens=0");
  await row(sheet, "Notion").getByRole("button", { name: "Connect", exact: true }).click();
  const card = app(sheet, "Notion");
  const link = card.getByRole("link", { name: "Open the sign-in page" });
  await expect(link).toBeVisible();
  expect(await link.getAttribute("href")).toContain("https://auth.fake-app.example/authorize");
});

test("any app can be added by its address and connects the same way", async ({ page, ui }) => {
  const sheet = await connectors(page, ui);
  const other = row(sheet, "Another app");
  await other.getByRole("button", { name: "Add", exact: true }).click();
  await other.getByRole("textbox", { name: "Name" }).fill("Tracker");
  await other.getByRole("textbox", { name: "Address" }).fill("https://mcp.tracker.example/mcp");
  await other.getByRole("button", { name: "Add app" }).click();
  const card = app(sheet, "Tracker");
  await expect(card.getByText("Approve in your browser")).toBeVisible();
  await approve(page);
  await expect(card.getByText("Connected as ada@example.com")).toBeVisible();
});

test("dot's offer in the conversation connects the app and answers by itself", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await ui.picture();
  // The fixture's connector for the card to connect; the tool adds it this way.
  await qa(page, "/__qa/connectors");
  await qa(page, "/__qa/ask?fields=connect");
  const card = page
    .getByRole("region", { name: "Connect Linear", exact: true })
    .filter({ visible: true })
    .first();
  await expect(card).toBeVisible();
  await expect(card.getByText("mcp.linear.app")).toBeVisible();
  await ui.settle();
  await pictures(page, "offer");
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(card.getByText("Approve Linear in your browser")).toBeVisible();
  await expect.poll(async () => (await connectInfo(page)).pages).toBe(1);
  await approve(page);
  await expect(card).toBeHidden({ timeout: 10_000 });
  const state = (await (await page.request.get(url(page, "/__qa/state"))).json()) as {
    effects: string[];
  };
  expect(state.effects.join(" ")).toContain("provided");
});
