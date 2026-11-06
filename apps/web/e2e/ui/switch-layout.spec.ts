import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, isPhone, runAt, test } from "./harness.ts";

// Taking up another conversation moves nothing while it loads: the list keeps its rows where they
// are, nothing is put in above them, the bars and the composer stay put, the bar's title is the
// new conversation's at once, and the thread's bones show only once the reading has lasted.
runAt("c14", "c39", "w14", "w39");
test.use({ fixedClock: false });

const TO = /Clean up my Downloads folder/;
const TITLE = "Clean up my Downloads folder";
const CHOICE_MS = 900;
const HISTORY_MS = 1500;

type Box = [number, number, number, number];
interface Frame {
  t: number;
  boxes: Record<string, Box>;
  notes: number;
  // The least opacity of any row's face: a list that dims while it waits reads below 1.
  rows: number;
  bones: number | null;
  title: string;
}

// What stays on screen through a switch, by view and width. On a phone Chat goes from the list to
// the conversation, so only the conversation's own parts are followed there.
function followed(page: Page, style: "chat" | "studio") {
  const phone = isPhone(page);
  if (style === "chat")
    return phone
      ? [".phone-chat-bar", '.phone-chat form[aria-label="Message dot"]']
      : [
          ".phone-list-screen .phone-search",
          ".phone-list-screen .phone-row-wrap",
          ".phone-list-screen .conversations-foot",
          ".phone-chat-bar",
          '.phone-chat form[aria-label="Message dot"]',
        ];
  return phone
    ? [".stage-box", '[aria-label="Conversation"] form[aria-label="Message dot"]']
    : [
        ".sessions-new",
        ".sessions-item",
        ".bar-l",
        ".bar-r",
        ".stage-box",
        '[aria-label="Conversation"] form[aria-label="Message dot"]',
      ];
}

// Samples every animation frame from now until `stop` is called.
async function sample(page: Page, selectors: string[]) {
  await page.evaluate((selectors) => {
    const frames: unknown[] = [];
    const start = performance.now();
    const w = window as unknown as {
      frames_: unknown[];
      sampling_: boolean;
      mark_: () => number;
    };
    w.frames_ = frames;
    w.sampling_ = true;
    w.mark_ = () => frames.length;
    const tick = () => {
      if (!w.sampling_) return;
      const boxes: Record<string, number[]> = {};
      for (const selector of selectors)
        document.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
          if (element.closest(".lift-copy, [inert]")) return;
          const box = element.getBoundingClientRect();
          if (!box.width || !box.height) return;
          const id = element.dataset.conversation ?? element.dataset.flip ?? String(index);
          boxes[`${selector} ${id}`] = [box.left, box.top, box.width, box.height].map(
            (value) => Math.round(value * 2) / 2,
          );
        });
      const faces = [
        ...document.querySelectorAll(
          ":is(.phone-row, .sessions-row, .conversations-pick) > .ui-button-content",
        ),
      ].map((face) => Number(getComputedStyle(face).opacity));
      const bones = document.querySelector(".thread-skeleton");
      frames.push({
        t: performance.now() - start,
        boxes,
        notes: document.querySelectorAll(".conversations-note").length,
        rows: Math.min(1, ...faces),
        bones: bones ? Number(getComputedStyle(bones).opacity) : null,
        title:
          document.querySelector(".bar-title, .phone-chat-bar .phone-title")?.textContent ?? "",
      });
      requestAnimationFrame(tick);
    };
    tick();
  }, selectors);
  return {
    // The frames from here on come after what the test does next.
    mark: () => page.evaluate(() => (window as unknown as { mark_: () => number }).mark_()),
    stop: async () =>
      (await page.evaluate(() => {
        const w = window as unknown as { frames_: unknown[]; sampling_: boolean };
        w.sampling_ = false;
        return w.frames_;
      })) as Frame[],
  };
}

// The conversation's choice and its history both answer late, once `slow` is set.
async function slowSwitch(page: Page) {
  let slow = false;
  const late = (ms: number) => async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    if (slow) await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => {});
  };
  await page.route("**/api/conversation/continue", late(CHOICE_MS));
  await page.route("**/api/sessions/*/history*", late(HISTORY_MS));
  return () => {
    slow = true;
  };
}

for (const style of ["chat", "studio"] as const)
  for (const appearance of ["graphite", "daylight"] as const)
    test(`${style} in ${appearance}: a slow switch moves nothing on screen while it loads`, async ({
      page,
      ui,
    }) => {
      test.setTimeout(90_000);
      await page.addInitScript(
        ([view, look]) => {
          localStorage.setItem("localdot.view-style.v1", view as string);
          localStorage.setItem("localdot.appearance.v1", look as string);
        },
        [style, appearance],
      );
      const slow = await slowSwitch(page);
      await ui.open("conversations");
      await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
      await expect(page.locator(".thread-row").first()).toBeAttached();
      let row = page.getByRole("button", { name: TO }).first();
      if (style === "studio" && isPhone(page)) {
        const sheet = page.getByRole("dialog", { name: "Conversations" });
        await expect(async () => {
          await page.getByRole("button", { name: "Conversations", exact: true }).click();
          await expect(sheet).toBeVisible({ timeout: 2000 });
        }).toPass();
        row = sheet.getByRole("button", { name: TO }).filter({ hasNotText: "Actions" }).first();
      }
      await expect(row).toBeVisible();
      await page.waitForTimeout(500);
      const selectors = followed(page, style);
      const sampling = await sample(page, selectors);
      await page.waitForTimeout(100);
      slow();
      const clicked = await sampling.mark();
      // Studio's rail is taken up without the pointer over it, whose lens would move the rows.
      if (style === "studio" && !isPhone(page)) await row.dispatchEvent("click");
      else await row.click();
      const landed = await sampling.mark();
      await page.waitForTimeout(600);
      await page.screenshot({ path: test.info().outputPath("during.png") });
      await expect(page.locator(".thread-skeleton")).toHaveCount(0, { timeout: 10_000 });
      await expect(page.locator(".thread-row").first()).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: test.info().outputPath("after.png") });
      const frames = await sampling.stop();
      const before = frames[Math.max(0, clicked - 1)];
      const after = frames.at(-1);
      if (!before || !after) throw new Error("no frames");

      // Each part followed keeps its box on every frame it shows, from the click to the end, and
      // where it showed before the click it is where it was.
      const moved: string[] = [];
      for (const [key, box] of Object.entries(after.boxes)) {
        const was = before.boxes[key];
        if (was && was.join() !== box.join()) moved.push(`${key}: ${was} -> ${box} (before)`);
        for (const frame of frames.slice(clicked)) {
          const at = frame.boxes[key];
          if (at && at.join() !== box.join()) {
            moved.push(`${key}: ${at} at ${Math.round(frame.t)} ms -> ${box}`);
            break;
          }
        }
      }
      const during = frames.slice(clicked);
      const first = during[0]?.t ?? 0;
      writeFileSync(
        test.info().outputPath("measured.json"),
        JSON.stringify(
          {
            followed: Object.keys(after.boxes).length,
            moved,
            notes: Math.max(...during.map((frame) => frame.notes)),
            leastRowOpacity: Math.min(...during.map((frame) => frame.rows)),
            titles: [...new Set(during.map((frame) => frame.title))],
            bonesBy200ms: Math.max(
              0,
              ...during.filter((f) => f.t - first < 180).map((f) => f.bones ?? 0),
            ),
            bonesLater: Math.max(0, ...during.map((frame) => frame.bones ?? 0)),
            bonesFrames: during.filter((frame) => frame.bones !== null).length,
            frames: during.length,
            span: Math.round((during.at(-1)?.t ?? 0) - first),
          },
          null,
          2,
        ),
      );
      expect(Object.keys(after.boxes).length).toBeGreaterThan(1);
      expect(moved).toEqual([]);
      // Nothing is put in under the search, and the rows don't dim while it waits.
      expect(Math.max(...during.map((frame) => frame.notes))).toBe(0);
      expect(Math.min(...during.map((frame) => frame.rows))).toBe(1);
      // The bar names the conversation taken up at once and never goes blank on the way.
      if (before.title)
        expect(new Set(frames.slice(landed + 2).map((frame) => frame.title))).toEqual(
          new Set([TITLE]),
        );
      // The thread's bones wait before they show, then come while the reading lasts.
      const early = during.filter((frame) => frame.t - first < 180);
      expect(Math.max(0, ...early.map((frame) => frame.bones ?? 0))).toBe(0);
      expect(Math.max(0, ...during.map((frame) => frame.bones ?? 0))).toBeGreaterThan(0.9);
    });
