import type { Page } from "@playwright/test";
import { wearAppearance } from "./contrast.ts";
import { composer, expect, test } from "./harness.ts";

// The "…" beside Send says how a message goes while dot works (Send after this task). It belongs
// to Send: in the row's end group, on Send's centre line, with no gap but the row's own between
// them, however many lines the message has, in either house. A phone's composer and Chat's offer
// the same choice from More instead.

interface Row {
  more: { left: number; right: number; mid: number } | null;
  send: { left: number; mid: number };
  // The next control after the "…", and the free space the row leaves before its end group.
  next: { left: number } | null;
  gap: number;
  freeAfterMore: number;
}

function measure(page: Page): Promise<Row> {
  return page.evaluate(() => {
    const bar = document.querySelector(".composer-card .composer-bar");
    if (!bar) throw new Error("No composer row");
    const shown = [...bar.children].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && getComputedStyle(element).visibility !== "hidden";
    });
    const more = bar.querySelector<HTMLElement>(".composer-more");
    const send = bar.querySelector<HTMLElement>(".composer-send");
    if (!send) throw new Error("No Send");
    const box = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, mid: r.top + r.height / 2 };
    };
    const at = more ? shown.indexOf(more) : -1;
    const next = at >= 0 ? shown[at + 1] : undefined;
    return {
      more: more && at >= 0 ? box(more) : null,
      send: box(send),
      next: next ? { left: next.getBoundingClientRect().left } : null,
      gap: Number.parseFloat(getComputedStyle(bar).columnGap) || 0,
      freeAfterMore:
        more && next ? next.getBoundingClientRect().left - more.getBoundingClientRect().right : 0,
    };
  });
}

async function typeMessage(page: Page, lines: number) {
  const field = (await composer(page)).getByRole("textbox").first();
  await field.click();
  await field.fill("");
  for (let line = 0; line < lines; line++) {
    if (line) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(`Line ${line + 1} of what dot should do next`);
  }
}

test.describe("Studio on a desktop", () => {
  test.beforeEach(() => {
    test.skip(!["c14", "w14"].includes(test.info().project.name), "Runs at c14 and w14");
  });

  for (const appearance of ["graphite", "daylight"] as const)
    test(`the message options sit with Send, in ${appearance}`, async ({ page, ui }) => {
      await ui.open("running");
      await ui.settle();
      await wearAppearance(page, appearance);
      for (const lines of [1, 3]) {
        await typeMessage(page, lines);
        const more = page.getByRole("button", { name: "Message options" });
        await expect(more).toBeVisible();
        await ui.still();
        await page
          .locator(".composer-card")
          .screenshot({ path: test.info().outputPath(`${appearance}-${lines}-lines.png`) });
        const row = await measure(page);
        expect(row.more).not.toBeNull();
        // Directly before Send, with the row's own gap between them, on Send's centre line.
        expect(row.next?.left).toBeCloseTo(row.send.left, 0);
        expect(row.freeAfterMore).toBeLessThanOrEqual(row.gap + 1);
        expect(Math.abs((row.more?.mid ?? 0) - row.send.mid)).toBeLessThanOrEqual(1);
        // It still opens its menu over the row.
        await more.click();
        await expect(page.getByRole("menuitem", { name: "Send after this task" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menuitem", { name: "Send after this task" })).toBeHidden();
      }
    });

  test("nothing else in the row moves as the options come and go", async ({ page, ui }) => {
    const fixture = await ui.open("running");
    await ui.settle();
    await typeMessage(page, 1);
    await expect(page.getByRole("button", { name: "Message options" })).toBeVisible();
    const places = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".composer-card .composer-bar > *")]
          .filter((element) => !element.classList.contains("composer-more"))
          .map((element) => {
            const r = element.getBoundingClientRect();
            return r.width ? `${element.className}@${Math.round(r.top)}` : null;
          })
          .filter(Boolean),
      );
    // Send's place in the card, to the pixel.
    const send = () =>
      page.locator(".composer-card .composer-send").evaluate((element) => {
        const box = element.getBoundingClientRect();
        const card = element.closest(".composer-card")?.getBoundingClientRect() ?? box;
        return [Math.round(card.right - box.right), Math.round(card.bottom - box.bottom)];
      });
    const shownWhileWorking = await places();
    const sendWhileWorking = await send();
    // dot finishes: the options go, and Send and the row stay where they were.
    await page.request.post(`${fixture.origin}/__qa/finish?done=1`);
    await expect(page.getByRole("button", { name: "Message options" })).toBeHidden();
    expect(await places()).toEqual(shownWhileWorking);
    expect(await send()).toEqual(sendWhileWorking);
  });

  // With motion on, the microphone beside it glides over as the options fold away and back, a few
  // pixels a frame, and Send keeps its place at the card's end.
  test("the row glides as the options go and come back", async ({ page, ui }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const fixture = await ui.open("running");
    await ui.settle();
    await typeMessage(page, 1);
    await expect(page.getByRole("button", { name: "Message options" })).toBeVisible();
    type Frame = { micToSend: number; sendToEnd: number; more: number };
    const more = page.locator(".composer-card .composer-more");
    // Every frame from the change until the options have settled, and a little after.
    const track = async (change: () => Promise<unknown>, settled: number) => {
      await page.evaluate(() => {
        const at = (selector: string) =>
          document.querySelector(`.composer-card ${selector}`)?.getBoundingClientRect() ??
          new DOMRect();
        const seen: Frame[] = [];
        const record = window as unknown as { seen: Frame[]; recording: boolean };
        record.seen = seen;
        record.recording = true;
        const frame = () => {
          const send = at(".composer-send");
          seen.push({
            micToSend: send.left - at(".voice-mic").left,
            sendToEnd: Math.round(at("").right - send.right),
            more: at(".composer-more").width,
          });
          if (record.recording) requestAnimationFrame(frame);
        };
        frame();
      });
      await change();
      await expect
        .poll(() => more.evaluate((element) => element.getBoundingClientRect().width))
        .toBe(settled);
      await page.waitForTimeout(300);
      return page.evaluate(() => {
        const record = window as unknown as { seen: Frame[]; recording: boolean };
        record.recording = false;
        return record.seen;
      });
    };
    const glides = (seen: Frame[]) => {
      const steps = seen
        .slice(1)
        .map((now, i) => Math.abs(now.micToSend - (seen[i]?.micToSend ?? now.micToSend)));
      const travel = Math.abs((seen.at(-1)?.micToSend ?? 0) - (seen[0]?.micToSend ?? 0));
      expect(new Set(seen.map((one) => one.sendToEnd)).size).toBe(1);
      expect(Math.abs(travel - 28)).toBeLessThanOrEqual(1);
      // Over several frames, never the whole way in one (a busy machine may drop a few).
      expect(steps.filter((step) => step > 0.5).length).toBeGreaterThan(2);
      expect(Math.max(...steps)).toBeLessThan(travel - 2);
    };
    // dot asks something, so a message would answer it, then works on once it's answered.
    glides(await track(() => page.request.post(`${fixture.origin}/__qa/ask`), 0));
    glides(
      await track(
        () =>
          page
            .locator("form.ask")
            .getByRole("button", { name: "Let dot decide", exact: true })
            .click(),
        24,
      ),
    );
  });
});

test.describe("phones and Chat", () => {
  test.beforeEach(() => {
    test.skip(!["c39", "w39"].includes(test.info().project.name), "Runs at c39 and w39");
  });

  for (const view of ["studio", "chat"] as const)
    test.describe(view, () => {
      test.use({ viewStyle: view });
      test("the choice lives in More, not in the field", async ({ page, ui }) => {
        await ui.open("running");
        await ui.settle();
        await typeMessage(page, 2);
        await expect(page.getByRole("button", { name: "Message options" })).toHaveCount(0);
        await page.getByRole("button", { name: "More", exact: true }).first().click();
        await expect(page.getByRole("menuitem", { name: "Send after this task" })).toBeVisible();
        await page.keyboard.press("Escape");
        await page
          .locator(".composer-card")
          .screenshot({ path: test.info().outputPath(`${view}.png`) });
      });
    });
});
