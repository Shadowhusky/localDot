import type { Page } from "@playwright/test";
import sharp from "sharp";
import { chatRail, expect, type Harness, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test.use({ fixedClock: false });

const LONG = encodeURIComponent("line of output\n".repeat(120));

const control = (page: Page, origin: string) => async (path: string) => {
  const reply = await page.request.post(`${origin}/__qa/${path}`);
  expect(reply.ok(), await reply.text()).toBe(true);
};

// What the stage shows: the desktop's empty home, the last task's window on it, or the web browser.
async function look(page: Page): Promise<"home" | "window" | "browser"> {
  const png = await page.locator(".watch .stage").first().screenshot({ animations: "disabled" });
  const [r = 0, g = 0, b = 0] = (await sharp(png).stats()).channels.map((c) => c.mean);
  if ((r + g + b) / 3 < 120) return "window";
  return b - r > 20 ? "home" : "browser";
}

async function shots(page: Page, ui: Harness, name: string) {
  for (const appearance of ["graphite", "midnight"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await ui.settle();
    await ui.still();
    await page.screenshot({ path: test.info().outputPath(`${name}-${appearance}.png`) });
  }
}

// Notes every toast the page shows from here on, however briefly it stays.
async function watchToasts(page: Page) {
  await page.evaluate(() => {
    const seen = new Set<string>();
    Object.assign(window, { toastsSeen: seen });
    new MutationObserver(() => {
      for (const title of document.querySelectorAll(".ui-toast-title"))
        seen.add(title.textContent ?? "");
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}
const toastsSeen = (page: Page, forget = false) =>
  page.evaluate((forget) => {
    const seen = (window as unknown as { toastsSeen: Set<string> }).toastsSeen;
    const titles = [...seen];
    if (forget) seen.clear();
    return titles;
  }, forget);

async function newConversation(page: Page) {
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "New conversation" }).click();
  } else await page.getByRole("button", { name: "New conversation" }).click();
  await expect(
    (await chatRail(page)).getByRole("heading", { name: "What should we do?" }),
  ).toBeVisible();
}

test("a new conversation shows the computer as it is, and only dot's own move is announced", async ({
  page,
  ui,
}) => {
  test.setTimeout(90_000);
  const fixture = await ui.open("running");
  const qa = control(page, fixture.origin);
  await ui.picture();
  // The last task ends in the web browser, which keeps its page; nothing is left on the desktop.
  await qa("screen?to=browser");
  await expect.poll(() => look(page)).toBe("browser");
  await qa("finish?done=1");
  await qa("desktop/home");

  await watchToasts(page);
  await newConversation(page);
  await expect.poll(() => look(page)).toBe("home");
  // The page went back to the desktop by itself: dot did not move, and the word that it moved to
  // the web browser no longer holds.
  await expect(page.locator(".ui-toast-title", { hasText: "dot moved" })).toHaveCount(0);
  expect(await toastsSeen(page, true)).not.toContain("dot is back on the desktop");
  await shots(page, ui, "new-conversation");

  const rail = await chatRail(page);
  const form = rail.getByRole("form", { name: "Message dot" });
  await form.getByRole("textbox", { name: /^(New task|Message)$/ }).fill("Plan a picnic");
  await form.getByRole("button", { name: /^(Start task|Send)$/ }).click();
  await expect(rail.getByText("Plan a picnic")).toBeVisible();
  // The task starts on the desktop, as the daemon's do; no earlier picture comes back meanwhile.
  // Watched for as long as toasts hold back words that just left (REPEAT_MS), so the move below can
  // be said again.
  await qa("screen");
  for (let sample = 0; sample < 20; sample++) {
    expect(await look(page)).toBe("home");
    await page.waitForTimeout(250);
  }

  // dot goes back to the web browser, which still shows what the last task left there, live.
  await qa("screen?to=browser");
  await expect.poll(() => look(page)).toBe("browser");
  await expect.poll(() => toastsSeen(page)).toContain("dot moved to the web browser");
  await shots(page, ui, "dot-moved");
});

test("a click or a tap on dot's work keeps following it; scrolling stops until Follow work", async ({
  page,
  ui,
  browserName,
}) => {
  test.setTimeout(90_000);
  const fixture = await ui.open("running");
  const qa = control(page, fixture.origin);
  await ui.picture();
  const phone = isPhone(page);
  const press = (target: ReturnType<Page["locator"]>) => (phone ? target.tap() : target.click());

  // Watching, the picture takes no input: a press on it reaches nothing on the computer.
  await press(page.locator(".watch .stage").first());
  await qa("work");
  await qa(`work?kind=output&text=${LONG}`);
  const work = page.getByRole("region", { name: "Work display" });
  const output = work.getByLabel("Work output");
  const view = work.getByRole("combobox", { name: "Display view" });
  const follow = work.getByRole("button", { name: "Follow work" });
  await expect(output).toContainText("line of output");
  await press(output);
  await qa("work?kind=files");
  await expect(output).toContainText("report.csv");
  await expect(view).toContainText("Auto");
  await expect(follow).toHaveCount(0);
  const inputs = await page.request.get(`${fixture.origin}/__qa/manual-inputs`);
  expect(await inputs.json()).toEqual([]);
  await shots(page, ui, "following");

  await qa("work");
  await qa(`work?kind=output&text=${LONG}`);
  await expect(output).toContainText("line of output");
  const box = await output.boundingBox();
  if (!box) throw new Error("The work output is not visible");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (phone && browserName === "chromium") {
    // A finger pans the output, as on a phone.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y - step * 15 }],
      });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else if (phone) {
    // Mobile WebKit takes no injected touches: a finger goes down and Safari takes it to pan.
    const finger = { pointerId: 2, pointerType: "touch", isPrimary: true, clientX: x, clientY: y };
    await output.dispatchEvent("pointerdown", { ...finger, buttons: 1 });
    await output.dispatchEvent("pointercancel", finger);
  } else {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 300);
  }
  await expect(view).toContainText("Work");
  await expect(follow).toBeVisible();
  await qa("work?kind=files");
  await page.waitForTimeout(1_000);
  await expect(output).not.toContainText("report.csv");
  await shots(page, ui, "stopped-following");

  await follow.click();
  await expect(output).toContainText("report.csv");
  await expect(view).toContainText("Auto");
  await expect(follow).toHaveCount(0);
});
