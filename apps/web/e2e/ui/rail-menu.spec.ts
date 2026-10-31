import type { Page } from "@playwright/test";
import { expect, type Harness, runAt, test } from "./harness.ts";

// A right click anywhere along a conversation's row opens that row's menu, in the collapsed rail
// under the dock's lens and in the expanded one, and nowhere on the list does the browser's own
// menu show in its place.
runAt("c14", "w14");
test.use({ fixedClock: false, reducedMotion: "no-preference" });

const rail = (page: Page) => page.getByRole("navigation", { name: "Conversations" });

interface Click {
  x: number;
  y: number;
  // The row drawn under the pointer, or level with it across the list.
  expected: string | null;
  opened: string | null;
  // Whether the page kept the browser's menu away.
  kept: boolean;
}

// Every right click from now on, and whether the page kept the browser's menu away.
async function watch(page: Page) {
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as unknown as { menus_: boolean[] }).menus_ = seen;
    window.addEventListener("contextmenu", (event) => seen.push(event.defaultPrevented));
  });
}

// Until the lens has stopped moving the marks.
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) => {
        let was = "";
        let still = 0;
        const started = performance.now();
        const look = () => {
          const now = [...document.querySelectorAll<HTMLElement>(".sessions-item")]
            .map((row) => `${row.style.scale}/${row.style.translate}`)
            .join(" ");
          still = now === was ? still + 1 : 0;
          was = now;
          if (still >= 3 || performance.now() - started > 1500) done();
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }),
  );

// Right-clicks where the mouse rests and says whose menu opened, closing it again.
async function rightClick(page: Page, x: number, y: number): Promise<Click> {
  const expected = await page.evaluate(
    ([x, y]) => {
      const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-flip]");
      if (hit) return hit.dataset.flip ?? null;
      // Beside a row, or in the 2 px gap between two, the nearer one.
      let nearest: string | null = null;
      let away = 2;
      for (const row of document.querySelectorAll<HTMLElement>(".sessions-item[data-flip]")) {
        const box = row.getBoundingClientRect();
        const distance = Math.max(0, box.top - y, y - box.bottom);
        if (distance < away) {
          nearest = row.dataset.flip ?? null;
          away = distance;
        }
      }
      return nearest;
    },
    [x, y] as const,
  );
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  const { opened, kept } = await page.evaluate(async () => {
    for (let frame = 0; frame < 2; frame++) await new Promise(requestAnimationFrame);
    const menus = (window as unknown as { menus_: boolean[] }).menus_.splice(0);
    return {
      opened:
        document.querySelector<HTMLElement>(".sessions-item[data-menu]")?.dataset.flip ?? null,
      kept: menus.length > 0 && menus.every(Boolean),
    };
  });
  if (opened) await page.keyboard.press("Escape");
  await expect(page.locator(".ui-layer")).toHaveCount(0);
  return { x, y, expected, opened, kept };
}

async function sweep(page: Page, xs: number[], top: number, bottom: number, step: number) {
  const clicks: Click[] = [];
  // Whole pixels, as WebKit places the mouse.
  for (const x of xs.map(Math.round))
    for (let y = Math.round(top); y <= bottom; y += step) {
      await page.mouse.move(x, y, { steps: 2 });
      await settle(page);
      clicks.push(await rightClick(page, x, y));
    }
  await test.info().attach(`right clicks ${xs.join(",")}`, {
    body: clicks
      .map(
        (click) => `${click.x},${click.y} ${click.expected} → ${click.opened} kept=${click.kept}`,
      )
      .join("\n"),
  });
  return clicks;
}

const missed = (clicks: Click[]) =>
  clicks.filter((click) => !click.kept || click.opened !== click.expected);

async function open(page: Page, ui: Harness) {
  await ui.open("conversations");
  const rows = rail(page).locator(".sessions-item");
  await expect(rows).toHaveCount(7);
  await expect(page.locator(".app")).toHaveAttribute("data-sessions", "collapsed");
  await watch(page);
  const first = await rows.nth(0).boundingBox();
  const fourth = await rows.nth(3).boundingBox();
  if (!first || !fourth) throw new Error("no rows");
  return { rows, first, fourth };
}

test("a right click anywhere along a magnified mark opens its menu, and never the browser's", async ({
  page,
  ui,
}) => {
  test.setTimeout(120_000);
  const { first, fourth } = await open(page, ui);
  // By the screen's edge, over the marks and where a grown mark reaches past the rail, from the
  // group's label down through four rows and the gaps between them.
  const clicks = await sweep(page, [1, 28, 66], first.y - 30, fourth.y + fourth.height + 4, 9);
  expect(clicks.filter((click) => click.expected).length).toBeGreaterThan(40);
  expect(clicks.filter((click) => !click.expected).length).toBeGreaterThan(5);
  expect(missed(clicks)).toEqual([]);
  await page.mouse.move(28, first.y + first.height / 2);
  await settle(page);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await expect(page.getByRole("menu", { name: "Conversation actions" })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("collapsed-menu.png"),
    clip: { x: 0, y: 0, width: 520, height: 560 },
  });
});

test("a right click along an expanded row or a search's opens its menu, and never the browser's", async ({
  page,
  ui,
}) => {
  test.setTimeout(120_000);
  const { rows } = await open(page, ui);
  await page.mouse.move(800, 500);
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(page.locator(".app")).toHaveAttribute("data-sessions", "expanded");
  await expect.poll(async () => (await rows.nth(0).boundingBox())?.width).toBeGreaterThan(200);
  const top = await rows.nth(0).boundingBox();
  const end = await rows.nth(3).boundingBox();
  if (!top || !end) throw new Error("no rows");
  const right = top.x + top.width;
  // From the rail's edge, over the names, over the time where the row's actions button waits
  // unseen, and past the row's end.
  const clicks = await sweep(
    page,
    [2, 150, right - 18, right + 4],
    top.y - 30,
    end.y + end.height + 4,
    8,
  );
  expect(clicks.filter((click) => click.expected).length).toBeGreaterThan(60);
  expect(missed(clicks)).toEqual([]);

  await rail(page).getByRole("textbox", { name: "Search conversations" }).fill("the");
  const results = rail(page).getByRole("list", { name: "Results" }).locator(".sessions-item");
  await expect(results.nth(2)).toBeVisible();
  const found = await results.nth(1).boundingBox();
  if (!found) throw new Error("no result");
  const middle = found.y + found.height / 2;
  const searched = await sweep(page, [2, 60, right - 18], middle - 4, middle + 4, 8);
  expect(searched.map((click) => click.expected)).not.toContain(null);
  expect(missed(searched)).toEqual([]);
});

test("a right click elsewhere while a menu is open only closes it, and the keys open it", async ({
  page,
  ui,
}) => {
  const { first, fourth } = await open(page, ui);
  await page.mouse.move(28, first.y + 18);
  await settle(page);
  await page.mouse.click(28, first.y + 18, { button: "right" });
  const menu = page.getByRole("menu", { name: "Conversation actions" });
  await expect(menu).toBeVisible();
  await page.mouse.click(28, fourth.y + 18, { button: "right" });
  await expect(menu).toBeHidden();
  await expect(page.locator(".ui-layer")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { menus_: boolean[] }).menus_.splice(0)),
  ).toEqual([true, true]);

  const row = rail(page).getByRole("button", { name: /^Clean up my Downloads/ });
  for (const key of ["Shift+F10", "ContextMenu"]) {
    await row.focus();
    await page.keyboard.press(key);
    await expect(menu).toBeVisible();
    await expect(row.locator("xpath=..")).toHaveAttribute("data-menu");
    await page.keyboard.press("Escape");
    await expect(page.locator(".ui-layer")).toHaveCount(0);
  }
  // Whatever the keys made of it, the browser's menu never came.
  expect(
    await page.evaluate(() => (window as unknown as { menus_: boolean[] }).menus_.splice(0)),
  ).not.toContain(false);
});
