import {
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";
import { reach } from "./reach.ts";
import { ENGINES } from "./ui-fixture.ts";

// The conversation against the fixture daemon's sample task: one scroller, a work line while dot
// works, its question answered in place of the composer, the result and recovery in the thread, and
// a reader who scrolled back left where they are.
test.describe.configure({ timeout: 120_000 });

const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const LAPTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
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
  const thread = page.getByRole("region", { name: "Conversation history" });
  await expect(thread.locator(".thread-row").first()).toBeVisible();
  return { browser, page, thread };
}

const qa = (path: string) => fetch(`${fixture?.origin}/__qa/${path}`, { method: "POST" });

// What scrolls in the chat: the rail's other views, laid over the thread, are out of reach.
function scrollers(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".rail-chat *")]
      .filter((element) => {
        const { overflowY } = getComputedStyle(element);
        return (
          !element.closest("[inert]") &&
          /auto|scroll/.test(overflowY) &&
          element.scrollHeight > element.clientHeight + 1
        );
      })
      .map((element) => element.className),
  );
}

const scroller = (page: Page) => page.locator(".thread-scroll");

// Whether the whole element is inside the thread's view, not just rendered somewhere in it.
async function onScreen(page: Page, target: Locator) {
  const [box, view] = await Promise.all([target.boundingBox(), scroller(page).boundingBox()]);
  return (
    !!box && !!view && box.y >= view.y - 0.5 && box.y + box.height <= view.y + view.height + 0.5
  );
}

const nextFrames = (page: Page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );

interface Frame {
  // Where the composer's top sits on the screen.
  composer: number;
  // Where the composer sits: under the thread or at its end.
  foot: string;
}

// One sample per drawn frame, taken just after the frame is drawn, while `act` runs.
async function framesDuring(page: Page, act: () => Promise<unknown>): Promise<Frame[]> {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    (window as unknown as { threadFrames: Frame[] }).threadFrames = frames;
    const drawn = new MessageChannel();
    drawn.port1.onmessage = () => {
      const composer = document.querySelector("form[aria-label='Message dot']");
      if (!composer) return;
      frames.push({
        composer: composer.getBoundingClientRect().top,
        foot: document.querySelector(".thread-dock")?.parentElement?.className ?? "",
      });
    };
    const tick = () => {
      drawn.port2.postMessage(0);
      if (frames.length < 150) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.waitForTimeout(200);
  await act();
  await page.waitForTimeout(1500);
  return page.evaluate(() => (window as unknown as { threadFrames: Frame[] }).threadFrames);
}

for (const [engine, size, options] of MATRIX) {
  test(`dot's work shows in the thread, in the column's only scroller (${engine} ${size})`, async () => {
    const { browser, page, thread } = await open(engine, options);
    const work = page.locator(".thread-work[data-live]");
    await expect(work).toContainText("Select the Net total cell");
    await expect(work.getByRole("button", { name: /Working · 6 steps/ })).toBeVisible();
    // Long enough to scroll, the thread is still the only thing in the column that does.
    await qa("say?n=12&text=Checking that each month adds up");
    await expect(thread.locator(".thread-row")).toHaveCount(14);
    // Measured once the new rows have eased in to their height.
    await expect.poll(() => scrollers(page)).toEqual(["ui-scroll-area thread-scroll"]);
    // The thread keeps saying what dot does as it moves on.
    await qa("steps?n=1&item=calc");
    await expect(work).toContainText("Fill area 1 with brown");
    await expect(work.getByRole("button", { name: /Working · 7 steps/ })).toBeVisible();
    // You in a bubble; dot's words go unbubbled, under no name of their own.
    await expect(thread.locator(".thread-bubble").first()).toContainText("Summarise the sample");
    await expect(thread.locator(".thread-message[data-role=dot] .thread-bubble")).toHaveCount(0);
    await browser.close();
  });

  // The composer stays in place as Answer dot, keeping what was typed; the question's choices come
  // in the thread beside a wide screen, or in a sheet on a phone.
  test(`a question keeps the composer and leaves the answer in the thread (${engine} ${size})`, async () => {
    const { browser, page, thread } = await open(engine, options);
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    await draft.fill("Keep this draft");
    await qa("ask");
    await expect(thread.getByRole("article", { name: "Question" })).toContainText(
      "Which report format should I use?",
    );
    const answer = page.getByRole("form", {
      name: size === "phone" ? "Which report format should I use?" : "Answer dot",
    });
    await expect(answer).toBeVisible();
    await expect(draft).toHaveAttribute("placeholder", "Answer dot");
    await expect(draft).toHaveValue("Keep this draft");
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
    await expect(thread.getByRole("button", { name: /Worked for/ })).toBeVisible();
    await expect(
      page
        .getByRole("complementary", { name: "Plan and steps", includeHidden: true })
        .locator(".result-card, [aria-label='Question history']"),
    ).toHaveCount(0);
    if (size === "phone") {
      for (const button of await card.getByRole("button").all())
        expect(await button.evaluate(reach)).toEqual({ width: 44, height: 44 });
    }
    await browser.close();
  });

  test(`a reader who scrolled back stays put while dot talks on (${engine} ${size})`, async () => {
    const { browser, page, thread } = await open(engine, options, { QA_ACTIVITY: "long" });
    await qa("say?n=24&text=Colouring the next patch of fur");
    await expect(thread.locator(".thread-row")).toHaveCount(26);
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

for (const engine of ["chrome", "webkit"] as const) {
  // A question never takes the keys from what you were typing; its choices answer by number.
  test(`a question that arrives while you type leaves you typing (${engine} 1440x900)`, async () => {
    const { browser, page } = await open(engine, DESKTOP);
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    await draft.click();
    await page.keyboard.type("Half a thought");
    await qa("ask");
    const answer = page.getByRole("form", { name: "Answer dot" });
    await expect(answer).toBeVisible();
    await nextFrames(page);
    await expect(draft).toBeFocused();
    await page.keyboard.type(" more");
    await expect(draft).toHaveValue("Half a thought more");
    await answer.getByRole("radio").first().focus();
    await page.keyboard.press("2");
    await expect(answer.getByRole("radio").nth(1)).toBeChecked();
    await browser.close();
  });

  test(`a long answer in your own words keeps the focus and every word (${engine} 1440x900)`, async () => {
    const { browser, page } = await open(engine, DESKTOP);
    await qa("ask");
    const answer = page.getByRole("form", { name: "Answer dot" });
    const words = answer.getByRole("textbox", { name: "Something else" });
    await words.click();
    const parts = Array.from({ length: 7 }, (_, index) => `Part ${index + 1} of my answer.`);
    for (const [index, part] of parts.entries()) {
      await page.keyboard.type(index ? ` ${part}` : part);
      await nextFrames(page);
    }
    await expect(words).toBeFocused();
    await expect(words).toHaveValue(parts.join(" "));
    await browser.close();
  });
}

for (const [engine, size, options] of [
  ["chrome", "1440x900", DESKTOP],
  ["chrome", "1280x800", LAPTOP],
  ["webkit", "phone", PHONE],
] as const) {
  test(`recovery shows its title and main action where the task paused (${engine} ${size})`, async () => {
    const { browser, page, thread } = await open(engine, options);
    await qa("budget");
    const recovery = thread.getByRole("region", { name: "Task recovery" });
    await expect(recovery).toContainText("$4 of $5 spent");
    const title = recovery.getByRole("heading", { name: "I stopped at your spending limit" });
    const raise = recovery.getByRole("button", { name: "Raise to $7 and continue" });
    await expect.poll(() => onScreen(page, title)).toBe(true);
    await expect.poll(() => onScreen(page, raise)).toBe(true);
    // Only the composer lies past it, so there is nothing newer to jump to.
    await expect(page.locator(".thread-jump")).not.toHaveAttribute("data-shown");
    // The run dot is at began after its last words: the one step since them.
    await expect(
      page
        .locator(".thread-work[data-live]")
        .getByRole("button", { name: /Waiting for you · 1 step/ }),
    ).toBeVisible();
    await raise.click();
    await expect(recovery).toHaveCount(0);
    await expect
      .poll(() => scroller(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(2);
    await browser.close();
  });
}

for (const [engine, size, options] of [
  ["chrome", "1440x900", DESKTOP],
  ["webkit", "phone", PHONE],
] as const) {
  // The composer stays in place as Answer dot (design-v2 §10.7), so nothing that happens in the
  // thread moves it, in or out of the thread or up and down.
  test(`a question, its answer and the task's end never move the composer (${engine} ${size})`, async () => {
    const { browser, page } = await open(engine, options);
    await expect(page.locator(".thread-work[data-live]")).toBeVisible();
    await page.waitForTimeout(600);
    const asked = await framesDuring(page, () => qa("ask"));
    const answered = await framesDuring(page, async () => {
      const answer = page.getByRole("form", {
        name: size === "phone" ? "Which report format should I use?" : "Answer dot",
      });
      await answer.getByRole("radio", { name: "Plain text" }).check();
      await answer.getByRole("button", { name: "Send answer" }).click();
    });
    const ended = await framesDuring(page, () => qa("finish"));
    await expect(page.getByRole("region", { name: "Task result" })).toBeVisible();
    const frames = [...asked, ...answered, ...ended];
    expect(new Set(frames.map((frame) => frame.foot)).size).toBe(1);
    const tops = frames.map((frame) => frame.composer);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(0.5);
    await browser.close();
  });
}

test("new rows and streaming words never shift what sits under the thread", async () => {
  // Tall enough that today's composer fits under the thread rather than joining its end.
  const { browser, page, thread } = await open("chrome", {
    viewport: { width: 1440, height: 1400 },
  });
  await expect(page.locator(".thread-foot > .thread-dock")).toHaveCount(1);
  // Let the first picture settle: the run dot is at opens in the thread as the task loads.
  await expect(page.locator(".thread-work[data-live]")).toBeVisible();
  await page.waitForTimeout(800);
  // The thread sits on the composer and follows its end, so its rows rise as words and rows land
  // (design-v2 §8.4); the work line and the composer under it hold still.
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
          .map((source) => source.node as Element | undefined)
          .filter((node) => !!node?.closest?.(".thread-foot"))
          .map((node) => node?.className ?? "");
        if (sources.length) shifts.push({ value: entry.value, sources });
      }
    }).observe({ type: "layout-shift", buffered: false });
    (window as unknown as { threadShifts: typeof shifts }).threadShifts = shifts;
  });
  await qa("say?stream=1&text=Checking that every month adds up before I write the summary");
  await expect(thread.locator(".thread-message").last()).toContainText("write the summary");
  await qa("steps?n=2&item=calc");
  await expect(page.locator(".thread-work[data-live]")).toContainText("Fill area 2 with brown");
  await page.waitForTimeout(600);
  const shifts = await page.evaluate(
    () => (window as unknown as { threadShifts: unknown[] }).threadShifts,
  );
  expect(shifts).toEqual([]);
  await browser.close();
});
