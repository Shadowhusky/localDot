import { type BrowserContextOptions, expect, type Page, test } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";
import { ENGINES } from "./ui-fixture.ts";

// The conversation against the fixture daemon's sample task: one scroller, a work line while dot
// works, its question answered in place of the composer, the result and recovery in the thread, and
// a reader who scrolled back left where they are.
test.describe.configure({ timeout: 120_000 });

const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
};
const MATRIX = [
  ["chrome", "desktop", DESKTOP],
  ["webkit", "desktop", DESKTOP],
  ["chrome", "phone", PHONE],
  ["webkit", "phone", PHONE],
] as const;

let fixture: UiFixture | undefined;
test.afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

async function open(
  engine: keyof typeof ENGINES,
  options: BrowserContextOptions,
  env: Record<string, string> = {},
) {
  fixture = await startUiFixture(env);
  const browser = await ENGINES[engine]();
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  if ((options.viewport?.width ?? 0) < 1180)
    await page.getByRole("tab", { name: /^Conversation/ }).click();
  const thread = page.getByRole("region", { name: "Conversation history" });
  await expect(thread.locator(".thread-row").first()).toBeVisible();
  return { browser, page, thread };
}

const qa = (path: string) => fetch(`${fixture?.origin}/__qa/${path}`, { method: "POST" });

function scrollers(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".pane-conversation *")]
      .filter((element) => {
        const { overflowY } = getComputedStyle(element);
        return /auto|scroll/.test(overflowY) && element.scrollHeight > element.clientHeight + 1;
      })
      .map((element) => element.className),
  );
}

const scroller = (page: Page) => page.locator(".thread-scroll");

for (const [engine, size, options] of MATRIX) {
  test(`dot's work shows under the thread, in the column's only scroller (${engine} ${size})`, async () => {
    const { browser, page, thread } = await open(engine, options);
    const work = page.locator(".thread-live .thread-work");
    await expect(work).toContainText("Select the Net total cell");
    await expect(work.getByRole("button", { name: /^Working · 6 steps/ })).toBeVisible();
    expect(await scrollers(page)).toEqual(["ui-scroll-area thread-scroll"]);
    // The thread keeps saying what dot does as it moves on.
    await qa("steps?n=1&item=calc");
    await expect(work).toContainText("Fill area 1 with brown");
    await expect(work.getByRole("button", { name: /^Working · 7 steps/ })).toBeVisible();
    // You in a bubble, dot under its name once.
    await expect(thread.locator(".thread-bubble").first()).toContainText("Summarise the sample");
    await expect(thread.locator(".thread-who")).toHaveCount(1);
    await browser.close();
  });

  test(`a question takes the composer's place and leaves the answer in the thread (${engine} ${size})`, async () => {
    const { browser, page, thread } = await open(engine, options);
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    await draft.fill("Keep this draft");
    await qa("ask");
    await expect(thread.getByRole("article", { name: "Question" })).toContainText(
      "Which report format should I use?",
    );
    const answer = page.getByRole("form", { name: "Answer dot" });
    await expect(answer).toBeVisible();
    await expect(draft).toBeHidden();
    await answer.getByRole("radio", { name: "Plain text" }).check();
    await answer.getByRole("button", { name: "Send answer" }).click();
    await expect(answer).toHaveCount(0);
    await expect(thread.getByRole("article", { name: "Your answer" })).toHaveText("Plain text");
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue("Keep this draft");
    await browser.close();
  });

  test(`the result and its files sit in the thread, not in Activity (${engine} ${size})`, async () => {
    const { browser, page, thread } = await open(engine, options);
    await qa("finish");
    const card = thread.getByRole("region", { name: "Task result" });
    await expect(card).toContainText("Sample monthly report prepared.");
    await expect(card.getByRole("button", { name: "Download summary.md" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Download all 2 files" })).toBeVisible();
    await expect(thread.getByRole("button", { name: /^Worked for/ })).toBeVisible();
    await expect(
      page
        .getByRole("complementary", { name: "Plan and steps", includeHidden: true })
        .locator(".result-card, [aria-label='Question history']"),
    ).toHaveCount(0);
    if (size === "phone") {
      for (const button of await card.getByRole("button").all()) {
        const box = await button.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
      }
    }
    await browser.close();
  });

  test(`a reader who scrolled back stays put while dot talks on (${engine} ${size})`, async () => {
    const { browser, page, thread } = await open(engine, options, { QA_ACTIVITY: "long" });
    await qa("say?n=8&text=Colouring the next patch of fur");
    await expect(thread.locator(".thread-row")).toHaveCount(10);
    await expect
      .poll(() => scroller(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(2);
    // Scroll back to the plan message and hold it.
    const plan = thread.getByText("I'll open the paint app, sketch the dog");
    await plan.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(300);
    const before = await plan.boundingBox();
    await qa("say?n=2&text=Shading the ears");
    const jump = page.locator(".thread-jump");
    await expect(jump.getByRole("button", { name: "2 new messages" })).toBeVisible();
    const after = await plan.boundingBox();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(1);
    await jump.getByRole("button").click();
    await expect
      .poll(() => scroller(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(2);
    await expect(jump).not.toHaveAttribute("data-shown");
    // At the end, new words follow the reader down, word by word.
    await qa("say?stream=1&text=Saving dog.png in Pictures now that the colours are done");
    await expect(thread.locator(".thread-message").last()).toContainText("colours are done");
    await expect
      .poll(() => scroller(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(2);
    await browser.close();
  });
}

test("recovery sits in the thread where the task paused", async () => {
  const { browser, page, thread } = await open("chrome", DESKTOP);
  await qa("budget");
  const recovery = thread.getByRole("region", { name: "Task recovery" });
  await expect(recovery).toContainText("Paused at the spending limit");
  await expect(recovery).toContainText("$4 of $5 spent");
  await expect(recovery.getByRole("button", { name: "Raise to $7 and continue" })).toBeVisible();
  await expect(
    page.locator(".thread-live").getByRole("button", { name: /^Paused · 6 steps/ }),
  ).toBeVisible();
  await browser.close();
});

test("new rows and streaming words never shift the thread or what sits under it", async () => {
  // Tall enough that today's composer fits under the thread rather than joining its end.
  const { browser, page, thread } = await open("chrome", {
    viewport: { width: 1440, height: 1400 },
  });
  await expect(page.locator(".thread-foot > .thread-dock")).toHaveCount(1);
  // Let the first picture settle: the work line opens under the thread as the task loads.
  await expect(page.locator(".thread-live .thread-work")).toBeVisible();
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const shifts: { value: number; sources: string[] }[] = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        value: number;
        hadRecentInput: boolean;
        sources: { node?: Node }[];
      }[]) {
        if (entry.hadRecentInput) continue;
        const sources = entry.sources
          .map((source) => (source.node as Element | undefined)?.className ?? "")
          .filter((name) => typeof name === "string" && name.includes("thread"));
        if (sources.length) shifts.push({ value: entry.value, sources });
      }
    }).observe({ type: "layout-shift", buffered: false });
    (window as unknown as { threadShifts: typeof shifts }).threadShifts = shifts;
  });
  await qa("say?stream=1&text=Checking that every month adds up before I write the summary");
  await expect(thread.locator(".thread-message").last()).toContainText("write the summary");
  await qa("steps?n=2&item=calc");
  await expect(page.locator(".thread-live .thread-work")).toContainText("Fill area 2 with brown");
  await page.waitForTimeout(600);
  const shifts = await page.evaluate(
    () => (window as unknown as { threadShifts: unknown[] }).threadShifts,
  );
  expect(shifts).toEqual([]);
  await browser.close();
});
