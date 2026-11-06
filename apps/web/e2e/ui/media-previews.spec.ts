import type { Page } from "@playwright/test";
import { PANEL_NAME } from "../../src/shell/panel-name.ts";
import { expect, isPhone, openFile, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");

const PICTURES = [
  ["First picture", "c8553d"],
  ["Second picture", "3d7ac8"],
  ["Third picture", "4fa36b"],
  ["Fourth picture", "b04fc8"],
  ["Fifth picture", "c8b43d"],
];

// A finished run that read five pictures, folded under its head.
async function run(page: Page, ui: { open(name: "image-output"): Promise<{ origin: string }> }) {
  const fixture = await ui.open("image-output");
  for (const [alt, colour] of PICTURES) {
    const read = await page.request.post(
      `${fixture.origin}/__qa/work?kind=image&alt=${encodeURIComponent(alt as string)}&colour=${colour}`,
    );
    expect(read.ok(), await read.text()).toBe(true);
  }
  const pictures = page.getByRole("list", { name: "Pictures" }).last();
  await expect(pictures.getByRole("button", { name: /^Show \d+ more pictures$/ })).toBeVisible();
  await pictures.scrollIntoViewIfNeeded();
  return pictures;
}

async function look(page: Page, name: string) {
  for (const appearance of ["graphite", "daylight"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.screenshot({ path: test.info().outputPath(`${name}-${appearance}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.appearance = "graphite";
  });
}

test("the last place opens a run's other pictures in place, leaving its steps alone", async ({
  page,
  ui,
}) => {
  const pictures = await run(page, ui);
  const steps = page.locator(".thread-work-steps > .ui-disclosure-trigger").last();
  const folded = await steps.getAttribute("aria-expanded");
  await look(page, "folded");
  await pictures.getByRole("button", { name: /^Show \d+ more pictures$/ }).click();

  await expect(pictures).toHaveAttribute("data-strip", "true");
  expect(await steps.getAttribute("aria-expanded")).toBe(folded);
  const names = pictures.getByRole("button");
  await expect(names).not.toHaveCount(3);
  await expect(names.nth(2)).toBeFocused();
  // One row, the same height, that scrolls sideways and rests on a picture.
  const row = await pictures.evaluate((list) => {
    const style = getComputedStyle(list);
    const tops = [...list.children].map((item) => item.getBoundingClientRect().top);
    return {
      overflows: list.scrollWidth > list.clientWidth,
      snap: style.scrollSnapType,
      overflowX: style.overflowX,
      rows: new Set(tops).size,
    };
  });
  expect(row).toEqual({ overflows: true, snap: "x mandatory", overflowX: "auto", rows: 1 });
  await look(page, "strip");
  await pictures.evaluate((list) => {
    list.scrollLeft = list.scrollWidth;
  });
  await expect.poll(() => pictures.evaluate((list) => list.scrollLeft)).toBeGreaterThan(0);

  // A picture in the row opens large, among the run's pictures.
  const last = names.last();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(page.locator(".viewer-count")).toContainText(/^(\d+) of \1$/);
});

test("the pictures move with the arrow keys and the visible controls, stopping at the ends", async ({
  page,
  ui,
}) => {
  const pictures = await run(page, ui);
  await pictures.getByRole("button", { name: "Preview image: First picture" }).click();
  const sheet = page.locator(".file-viewer");
  const count = sheet.locator(".viewer-count");
  const total = Number(((await count.textContent()) ?? "").split(" of ")[1]);
  expect(total).toBeGreaterThanOrEqual(PICTURES.length);
  await expect(count).toHaveText(`1 of ${total}`);
  const previous = sheet.getByRole("button", { name: "Previous picture" });
  const next = sheet.getByRole("button", { name: "Next picture" });
  await expect(previous).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(count).toHaveText(`1 of ${total}`);
  await page.keyboard.press("ArrowRight");
  await expect(count).toHaveText(`2 of ${total}`);
  await expect(page.getByRole("dialog", { name: "Second picture" })).toBeVisible();
  await next.click();
  await expect(page.getByRole("dialog", { name: "Third picture" })).toBeVisible();
  await previous.click();
  await expect(page.getByRole("dialog", { name: "Second picture" })).toBeVisible();
  const shown = sheet.locator(".viewer-pane:not([data-aside]) img");
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
  await ui.settle();
  await look(page, "viewer");
  for (let at = 2; at < total; at++) await page.keyboard.press("ArrowRight");
  await expect(count).toHaveText(`${total} of ${total}`);
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("ArrowRight");
  await expect(count).toHaveText(`${total} of ${total}`);
});

test("a read image opens as itself, from a press anywhere on it", async ({ page, ui }) => {
  await ui.open("image-output");
  if (isPhone(page)) await page.getByRole("button", { name: PANEL_NAME, exact: true }).click();
  else await page.getByRole("radio", { name: PANEL_NAME, exact: true }).click();
  const row = page
    .locator(".activity-rail")
    .getByTestId("tool-row")
    .filter({ hasText: "read flower-poster/assets/hero1.jpg" });
  await row.getByRole("button", { name: /read flower-poster/ }).click();
  const image = row.getByRole("img", { name: "~/flower-poster/assets/hero1.jpg" });
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
  await image.scrollIntoViewIfNeeded();
  // Its caption stays as words, and is not offered as what the step shows large.
  await expect(row.getByText("hero1.jpg · 80427 bytes")).toBeVisible();
  await expect(row.getByRole("button", { name: "Preview output" })).toHaveCount(0);

  const figure = row.getByRole("figure", { name: "Image output" });
  const glyph = figure.locator(".ui-picture-cover-glyph");
  if (isPhone(page)) await expect(glyph).toHaveCSS("opacity", "1");
  else {
    await row.locator(".activity-row-head").hover();
    await expect(glyph).toHaveCSS("opacity", "0");
    await figure.hover();
    await expect(glyph).toHaveCSS("opacity", "1");
  }
  const box = await image.boundingBox();
  const mark = await glyph.boundingBox();
  if (!box || !mark) throw new Error("Nothing to measure");
  expect(mark.x + mark.width / 2).toBeCloseTo(box.x + box.width / 2, 0);
  expect(mark.y + mark.height / 2).toBeCloseTo(box.y + box.height / 2, 0);
  await look(page, "step-image");

  // Off the glyph, near a corner of the picture.
  await figure.click({ position: { x: 12, y: 12 } });
  const sheet = page.locator(".file-viewer");
  const large = sheet.getByRole("img", { name: "~/flower-poster/assets/hero1.jpg" });
  await expect.poll(() => large.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
  await expect(sheet.getByRole("region", { name: "Step output preview" })).toHaveCount(0);
});

test("every line of a file is drawn the same size, Chinese and very long lines too", async ({
  page,
  ui,
  browserName,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/previews`);
  const lines = [
    "// 中文注释：这一行混合了中文和 ASCII，用来检查行高",
    "const short = 1;",
    "",
    `const title = "${"你好世界，这是一段很长的文字。".repeat(12)}";`,
    "function ligatures(a, b) { return a => b !== a && a >= b; }",
    `const long = "${"x".repeat(600)}";`,
    "return short;",
  ];
  await page.route("**/clean.py/text*", (route) =>
    route.fulfill({ json: { kind: "text", from: "start", lines, truncated: false } }),
  );
  const card = page.getByRole("region", { name: "Task result" }).last();
  await card.getByRole("button", { name: /^Show \d+ more files$/ }).click();
  await openFile(page, "clean.py", card);
  const code = page.getByRole("region", { name: "Contents of clean.py" });
  await expect(code.locator(".viewer-code-line")).toHaveCount(lines.length);
  // A phone's browser left to itself enlarges long lines more than short ones. The phone builds
  // are the only WebKit that knows the property, so Chromium speaks for the stylesheet here.
  if (browserName === "chromium")
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("text-size-adjust"),
      ),
    ).toBe("100%");
  const measure = () =>
    code.locator(".viewer-code-line").evaluateAll((rows) =>
      rows.map((row) => {
        const text = row.querySelector(".viewer-code-text") as HTMLElement;
        const number = row.querySelector(".viewer-code-number") as HTMLElement;
        const inner = [...text.querySelectorAll("span")].map(
          (tone) => getComputedStyle(tone).fontSize,
        );
        return {
          height: row.getBoundingClientRect().height,
          numberTop: number.getBoundingClientRect().top - row.getBoundingClientRect().top,
          sizes: [
            ...new Set([
              getComputedStyle(text).fontSize,
              ...inner,
              getComputedStyle(number).fontSize,
            ]),
          ],
          lineHeight: getComputedStyle(text).lineHeight,
        };
      }),
    );
  for (const appearance of ["graphite", "daylight"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    // Unwrapped first, then wrapped: a wrapped line is whole lines tall, its number on its first.
    const rows = await measure();
    expect(new Set(rows.map((row) => row.height))).toEqual(new Set([19]));
    await page.screenshot({ path: test.info().outputPath(`code-${appearance}.png`) });
    const wrap = page.getByRole("switch", { name: "Wrap lines" });
    await wrap.click();
    for (const row of await measure()) {
      expect(row.height % 19).toBe(0);
      expect(row.numberTop).toBe(0);
      expect(row.sizes).toEqual(["12.5px"]);
      expect(row.lineHeight).toBe("19px");
    }
    await page.screenshot({ path: test.info().outputPath(`code-wrapped-${appearance}.png`) });
    await wrap.click();
  }
});

test("a long file name keeps its start and extension and never reaches the size", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  const handed = await page.request.post(`${fixture.origin}/__qa/long-names`);
  expect(handed.ok(), await handed.text()).toBe(true);
  const card = page.getByRole("region", { name: "Task result" }).last();
  const widths = isPhone(page) ? [320, 360, 390] : [1440];
  for (const width of widths) {
    if (isPhone(page)) await page.setViewportSize({ width, height: 740 });
    await card.scrollIntoViewIfNeeded();
    await ui.settle();
    for (const row of await card.locator(".deliverable .ui-file-row").all()) {
      const box = await row.evaluate((element) => {
        const rect = (selector: string) => {
          const found = element.querySelector(selector);
          if (!found) throw new Error(`No ${selector}`);
          return found.getBoundingClientRect();
        };
        const name = rect(".ui-file-name");
        const meta = rect(".ui-file-meta");
        const actions = rect(".ui-file-actions");
        const middle = element.querySelector(".ui-middle-name") as HTMLElement;
        const parts = [...middle.children].map((part) => part.getBoundingClientRect());
        return {
          gap: meta.left - name.right,
          room: actions.left - meta.right,
          // The start shows, and the tail, with its extension, is whole.
          head: parts[0]?.width ?? 0,
          tailEnd: (parts.at(-1)?.right ?? 0) - name.right,
          rowEnd: element.getBoundingClientRect().right - actions.right,
        };
      });
      expect(box.gap, `name clears the size at ${width}`).toBeGreaterThan(0);
      expect(box.room, `size clears the actions at ${width}`).toBeGreaterThanOrEqual(0);
      expect(box.head, `start of the name at ${width}`).toBeGreaterThan(20);
      expect(box.tailEnd, `end of the name at ${width}`).toBeLessThanOrEqual(0.5);
      expect(box.rowEnd).toBeGreaterThanOrEqual(0);
    }
    await look(page, `names-${width}`);
  }

  const name = "quarterly-revenue-report-final-version-2-reviewed.pdf";
  const row = card.getByRole("listitem", { name });
  await expect(row.locator(".ui-middle-name")).toHaveAttribute("title", name);
  await row.getByRole("button", { name: `More for ${name}` }).click();
  const menu = page.getByRole("menu", { name: `Actions for ${name}` });
  await expect(menu.getByText(name, { exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Open" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("menu.png") });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    menu.getByRole("menuitem", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(name);
  await row.getByRole("button", { name: `More for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Open" }).click();
  await expect(page.getByRole("dialog", { name })).toBeVisible();
});
