import { expect, type Page, test } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "../fixtures/start-ui-fixture.ts";
import { openSettings } from "../settings-ui.ts";
import { skipSetup } from "../skip-setup.ts";
import { isPhone } from "./harness.ts";

// Two localDots on their own addresses, as on two computers: the user adds the office in the
// studio, switches there, and the office then lists the studio, by its name and its dot's look.
test.beforeEach(() => {
  test.skip(!["c14", "w39"].includes(test.info().project.name), "Runs at c14 and w39");
});

// WebKit reports the page's own requests and imports that a navigation cuts off as errors.
const CUT_OFF = /due to access control checks|^Load failed$|^Importing a module script failed\.$/;

const auth = { authorization: `Bearer ${TOKEN}` };

async function setLook(page: Page, at: UiFixture, look: Record<string, string>) {
  const saved = await (
    await page.request.get(`${at.origin}/api/agent/settings`, { headers: auth })
  ).json();
  const reply = await page.request.put(`${at.origin}/api/agent/settings`, {
    headers: auth,
    data: { ...saved, ...look },
  });
  expect(reply.ok(), await reply.text()).toBe(true);
}

const savedList = async (page: Page, at: UiFixture) =>
  (await (await page.request.get(`${at.origin}/api/agent/settings`, { headers: auth })).json())
    .localDots;

// The localDot menu on a wide screen, More on a phone, which has no top bar.
async function openMenu(page: Page) {
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    return page.getByRole("menu");
  }
  await page.getByRole("button", { name: /Switch localDot/ }).click();
  return page.getByRole("menu", { name: "localDots" });
}

const signedIn = (page: Page) =>
  page.getByRole("button", { name: /Switch localDot|^More$/ }).first();

const entry = (page: Page, name: string) =>
  page.getByRole("menuitem", { name: isPhone(page) ? `Switch to ${name}` : new RegExp(name) });

async function switchTo(page: Page, name: string, to: UiFixture) {
  await openMenu(page);
  await entry(page, name).click();
  await page.waitForURL(`${to.origin}/`);
}

test("a localDot switched to from another lists it back, with its look, and switches back", async ({
  page,
}) => {
  const studio = await startUiFixture({ QA_SCENARIO: "ready" }, "two-localdots-studio");
  const office = await startUiFixture({ QA_SCENARIO: "ready" }, "two-localdots-office");
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    if (!CUT_OFF.test(error.message)) errors.push(error.message);
  });
  await page.route("**/*", (route) => {
    const { origin } = new URL(route.request().url());
    return [studio.origin, office.origin].includes(origin) ? route.continue() : route.abort();
  });
  const officeHost = new URL(office.origin).host;
  const studioHost = new URL(studio.origin).host;
  try {
    await skipSetup(page);
    await setLook(page, studio, { name: "Studio Mac", persona: "coder", accessory: "cap" });
    await setLook(page, office, { name: "Office PC", accessory: "bow" });
    // This browser is signed in to both, as after pasting each one's sign-in link.
    for (const at of [office, studio]) {
      await page.goto(`${at.origin}/#token=${TOKEN}`);
      await expect(signedIn(page)).toBeVisible();
    }

    // A link from anywhere but that localDot itself lists nothing.
    await page.goto(
      `${office.origin}/#from=${encodeURIComponent("https://evil.example")}&name=Studio`,
    );
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
    await expect(signedIn(page)).toBeVisible();
    await page.goto(`${studio.origin}/`);
    await expect(signedIn(page)).toBeVisible();
    await page.goto(`${office.origin}/#from=${encodeURIComponent(studio.origin)}&name=Forged`);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
    let menu = await openMenu(page);
    await expect(menu).not.toContainText("Forged");
    await expect(menu).not.toContainText("evil.example");
    await expect(menu).not.toContainText(studioHost);
    await page.keyboard.press("Escape");

    // The user adds the office in the studio, by its address only, and switches there.
    await page.goto(`${studio.origin}/`);
    const sheet = await openSettings(page, undefined, "Your dot");
    const list = sheet.locator("div:has(> .ui-group-head:has-text('Your other localDots'))");
    await list.scrollIntoViewIfNeeded();
    await list.getByRole("textbox", { name: "Address" }).fill(office.origin);
    await list.getByRole("button", { name: "Add" }).click();
    await expect(list).toContainText(officeHost);
    await expect.poll(() => savedList(page, studio)).toHaveLength(1);
    await page.goto(`${studio.origin}/`);
    await switchTo(page, officeHost, office);

    // The office lists the studio, as the studio names itself, though nobody added it there.
    menu = await openMenu(page);
    await expect(entry(page, "Studio Mac")).toBeVisible();
    if (!isPhone(page)) {
      await expect(entry(page, "Studio Mac")).toContainText(studioHost);
      await expect(entry(page, "Studio Mac").locator(".dot")).toBeVisible();
    }
    await page.screenshot({ path: test.info().outputPath("office-lists-studio.png") });
    await page.keyboard.press("Escape");

    // In Settings it is this browser's. The studio is at a loopback address, which on another
    // device would be that device's own computer, so it can't join the list every device shares.
    const officeSheet = await openSettings(page, undefined, "Your dot");
    const officeList = officeSheet.locator(
      "div:has(> .ui-group-head:has-text('Your other localDots'))",
    );
    await officeList.scrollIntoViewIfNeeded();
    await expect(officeList).toContainText(`${studioHost} · Only in this browser`);
    await page.screenshot({ path: test.info().outputPath("office-settings-browser-only.png") });
    const keep = officeList.getByRole("button", { name: "Keep Studio Mac in the list" });
    await expect(keep).toHaveAttribute("aria-disabled", "true");
    await expect(keep).toHaveAccessibleDescription("Its address works only on this device");
    expect(await savedList(page, office)).toBeUndefined();
    await page.goto(`${office.origin}/`);

    // One choice back. The studio now shows the office as the office names itself, with its look.
    await switchTo(page, "Studio Mac", studio);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
    menu = await openMenu(page);
    await expect(entry(page, "Office PC")).toBeVisible();
    if (!isPhone(page)) {
      await expect(entry(page, "Office PC")).toContainText(officeHost);
      await expect(entry(page, "Office PC").locator(".dot")).toBeVisible();
    }
    await page.screenshot({ path: test.info().outputPath("studio-lists-office.png") });
    await page.keyboard.press("Escape");

    // A browser signed out of the studio goes back to its usual sign-in, never a dead end.
    await page.evaluate(() => localStorage.removeItem("localdot.token"));
    await page.goto(`${office.origin}/`);
    await switchTo(page, "Studio Mac", studio);
    await expect(page.getByRole("heading", { name: "Open localDot from Terminal" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
    await page.screenshot({ path: test.info().outputPath("studio-sign-in.png") });
    expect(errors).toEqual([]);
  } finally {
    await studio.close();
    await office.close();
  }
});
