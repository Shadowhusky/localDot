import type { Page } from "@playwright/test";
import { TOKEN, type UiFixture } from "../fixtures/start-ui-fixture.ts";
import { expect, type Harness, isPhone, runAt, test } from "./harness.ts";

// From the press of Send, dot is seen thinking however long its brain takes to say so, and its own
// thinking takes over with nothing in between. A send that fails leaves dot as it was.

// How long dot's brain says nothing about a message, as a real one starting up; then its reply.
const WAKE_MS = 2500;
const REPLY_MS = 1500;
const SEND = /^(Start task|Send|Send follow-up|Send now)$/;

interface Frame {
  t: number;
  dot: string;
  island: string;
  foot: string;
  lines: number;
  stray: number;
  yours: number;
}

const form = (page: Page) => page.getByRole("form", { name: "Message dot" }).last();

// dot has come to rest in its place over a live picture, so nothing else moves it as Send is pressed.
async function settled(page: Page, ui: Harness) {
  await expect(page.locator('.presence-frame[data-place="dock"][data-shown]')).toBeAttached();
  await ui.picture();
  await ui.settle();
}

// Sends `text`, noting each frame from the press: dot's state ("" while it is not on show), the
// island's word, the thread's lines for dot at work after the message and before it, and how many
// rows show the message.
async function sendWatched(page: Page, text: string) {
  await form(page).getByRole("textbox").first().fill(text);
  const send = form(page).getByRole("button", { name: SEND });
  await expect(send).toBeEnabled();
  await send.evaluate((button, words) => {
    const seen = window as unknown as { sentAt?: number; frames: Frame[] };
    seen.frames = [];
    button.addEventListener("click", () => {
      seen.sentAt ??= performance.now();
    });
    const read = () => {
      if (seen.sentAt !== undefined) {
        const dot = document.querySelector<HTMLElement>(".presence-frame");
        const yours = [...document.querySelectorAll(".thread-row[data-speaker='user']")].filter(
          (row) => row.textContent?.includes(words),
        );
        const lines = [...document.querySelectorAll(".thread-work[data-live]")];
        const after = lines.filter(
          (line) =>
            !!yours[0] &&
            !!(yours[0].compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING),
        ).length;
        seen.frames.push({
          t: performance.now() - seen.sentAt,
          dot: dot?.dataset.shown === undefined ? "" : (dot.dataset.state ?? ""),
          island: document.querySelector(".island [data-testid='hud-status']")?.textContent ?? "",
          foot: document.querySelector(".dot-strip .narration-line")?.textContent ?? "",
          lines: after,
          stray: lines.length - after,
          yours: yours.length,
        });
      }
      requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
  }, text);
  await send.click();
}

const framesSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { frames: Frame[] }).frames);

async function stopTask(page: Page, fixture: UiFixture) {
  const state = await (await page.request.get(`${fixture.origin}/__qa/state`)).json();
  const stopped = await page.request.post(
    `${fixture.origin}/api/agent/sessions/${state.sessionId}/stop`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
  expect(stopped.ok()).toBe(true);
}

// Until dot replies, it shows thinking from the first frame it does, through its brain's own first
// word, with one row for the message and, in Studio, one line for dot at work under it and none
// over a turn before it.
async function sendMeasured(page: Page, studio: boolean, text: string) {
  await sendWatched(page, text);
  const until = WAKE_MS + REPLY_MS - 200;
  await expect
    .poll(async () => (await framesSeen(page)).at(-1)?.t ?? 0, { timeout: until + 10_000 })
    .toBeGreaterThan(until);
  const frames = (await framesSeen(page)).filter((frame) => frame.t < until);
  const first = frames.findIndex((frame) => frame.dot === "thinking");
  const shown = frames[first]?.t ?? Number.POSITIVE_INFINITY;
  test.info().annotations.push({
    type: "sent-thinking",
    description: `dot thinking ${Math.round(shown)} ms after Send, its brain silent ${WAKE_MS} ms`,
  });
  expect(shown).toBeLessThan(400);
  const thinking = frames.slice(first);
  // Wherever dot shows; a new conversation's dot is between places for a moment as it docks.
  expect(new Set(thinking.map((frame) => frame.dot).filter(Boolean))).toEqual(
    new Set(["thinking"]),
  );
  if (studio)
    expect(new Set(thinking.map((frame) => frame.island))).toEqual(new Set(["Thinking…"]));
  // Chat has no island, so dot's line at the foot says it, the greeting gone by then.
  else
    for (const frame of thinking.filter((frame) => frame.t > 500))
      expect(frame.foot).toContain("Thinking…");
  for (const frame of frames) {
    expect(frame.lines).toBeLessThanOrEqual(1);
    expect(frame.stray).toBe(0);
    expect(frame.yours).toBeLessThanOrEqual(1);
  }
  if (studio) {
    const landed = frames.findIndex((frame) => frame.lines === 1);
    expect(frames[landed]?.t ?? Number.POSITIVE_INFINITY).toBeLessThan(1000);
    expect(frames.slice(landed).every((frame) => frame.lines === 1 && frame.yours === 1)).toBe(
      true,
    );
  }
}

for (const style of ["studio", "chat"] as const)
  test.describe(`in ${style}`, () => {
    test.use({ viewStyle: style });
    const studio = style === "studio";

    test.describe("measured", () => {
      runAt("c14", "c39", "w14", "w39");

      test("a new task after one that stopped shows dot thinking at Send", async ({ page, ui }) => {
        const fixture = await ui.open("running");
        await stopTask(page, fixture);
        await expect(page.getByText(/Stopped/).first()).toBeVisible();
        await settled(page, ui);
        await page.request.post(`${fixture.origin}/__qa/reply?ms=${REPLY_MS}&wake=${WAKE_MS}`);
        await sendMeasured(page, studio, "Start the report again");
        await expect(page.getByText("Sample reply: I received the task.").last()).toBeVisible();
      });

      test("a new conversation's first message shows dot thinking at Send", async ({
        page,
        ui,
      }) => {
        const fixture = await ui.open("done");
        if (isPhone(page)) {
          await page.getByRole("button", { name: "More", exact: true }).click();
          await page.getByRole("menuitem", { name: "New conversation" }).click();
        } else await page.getByRole("button", { name: "New conversation" }).first().click();
        await expect(page.getByRole("heading", { name: "What should we do?" })).toBeVisible();
        await ui.picture();
        await ui.settle();
        await page.request.post(`${fixture.origin}/__qa/reply?ms=${REPLY_MS}&wake=${WAKE_MS}`);
        await sendMeasured(page, studio, "Tidy the sample sheet");
      });

      test("a follow-up to a task at rest shows dot thinking at Send", async ({ page, ui }) => {
        const fixture = await ui.open("done");
        await settled(page, ui);
        await page.request.post(`${fixture.origin}/__qa/reply?ms=${REPLY_MS}&wake=${WAKE_MS}`);
        // The message's echo in the task's feed comes before the send's own reply, as it can.
        await page.route("**/messages", async (route) => {
          const response = await route.fetch();
          await new Promise((resolve) => setTimeout(resolve, 400));
          await route.fulfill({ response });
        });
        await sendMeasured(page, studio, "Check the totals once more");
        // dot's reply ends its turn, and nothing is left showing it at work.
        await expect(page.getByText("Sample reply: I checked again.").last()).toBeVisible();
        await expect(page.locator(".presence-frame")).not.toHaveAttribute("data-state", "thinking");
        await expect(page.locator(".thread-work[data-live]")).toHaveCount(0);
      });
    });

    test.describe("reverted", () => {
      runAt("c14", "w39");

      test("a send that fails leaves dot as it was", async ({ page, ui }) => {
        await ui.open("done");
        await settled(page, ui);
        await page.route("**/messages", (route) => route.abort());
        await sendWatched(page, "Check the totals once more");
        await expect(page.getByRole("region", { name: "Message delivery" })).toContainText(
          "Not sure dot got that.",
        );
        await expect(page.locator(".presence-frame")).not.toHaveAttribute("data-state", "thinking");
        if (studio) await expect(page.locator(".island")).not.toContainText("Thinking…");
        await expect(page.locator(".thread-work[data-live]")).toHaveCount(0);
      });
    });
  });
