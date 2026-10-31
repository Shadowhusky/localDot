import type { Page } from "@playwright/test";
import sharp from "sharp";
import { expect, runAt, test } from "./harness.ts";

// The stage keeps its picture while the columns around it change, and the collapsed rail magnifies
// under the mouse as the macOS Dock does. Chromium only: frames come from its screencast.
runAt("c14");
test.use({ fixedClock: false, reducedMotion: "no-preference" });

const PANELS = "localdot.panels.v1";

// Every frame the compositor makes while `act` runs and for `ms` after it.
async function screencast(page: Page, act: () => Promise<void>, ms: number): Promise<Buffer[]> {
  const cdp = await page.context().newCDPSession(page);
  const shots: Buffer[] = [];
  cdp.on("Page.screencastFrame", (frame) => {
    shots.push(Buffer.from(frame.data, "base64"));
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await page.waitForTimeout(300);
  await act();
  await page.waitForTimeout(ms);
  await cdp.send("Page.stopScreencast");
  await cdp.detach();
  return shots;
}

// The share of the stage's side of a frame brighter than the page around it: next to none when the
// picture is blank.
async function lit(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png)
    .extract({ left: 60, top: 120, width: 900, height: 500 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bright = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) > 120) bright++;
  return bright / (info.width * info.height);
}

async function livePicture(page: Page) {
  await expect(page.locator(".stage.lit").first()).toBeVisible();
  await expect(page.locator(".curtain")).toHaveCount(0);
  await expect
    .poll(() => page.locator(".stage canvas").first().getAttribute("data-frames"))
    .not.toBe("0");
  await page.waitForTimeout(1500);
}

const rail = (page: Page) => page.getByRole("navigation", { name: "Conversations" });

async function narrow(page: Page) {
  for (let width = 1420; width >= 1220; width -= 20) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(16);
  }
}

// Every way the stage changes size beside it: the conversations rail opening and closing (its
// toggle, Mod+\ and a conversation taken up, which opens the chat), the chat hidden and dragged
// wider, the window narrowed, and Replay's picture as the window narrows.
const RESIZES: {
  name: string;
  panels?: Record<string, unknown>;
  replay?: boolean;
  act(page: Page): Promise<void>;
}[] = [
  {
    name: "rail-expand",
    act: (page) => rail(page).getByRole("button", { name: "Expand conversations" }).click(),
  },
  {
    name: "rail-collapse",
    panels: { sessions: true },
    act: (page) => rail(page).getByRole("button", { name: "Collapse conversations" }).click(),
  },
  { name: "rail-shortcut", act: (page) => page.keyboard.press("ControlOrMeta+Backslash") },
  {
    name: "session-opens-chat",
    panels: { chat: false },
    act: (page) =>
      rail(page)
        .getByRole("button", { name: /^Clean up my Downloads/ })
        .click(),
  },
  { name: "chat-hide", act: (page) => page.getByRole("button", { name: "Hide chat" }).click() },
  {
    name: "chat-drag",
    async act(page) {
      const box = await page.getByRole("separator", { name: "Conversation width" }).boundingBox();
      if (!box) throw new Error("no width handle");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 160, box.y + box.height / 2, { steps: 20 });
      await page.mouse.up();
    },
  },
  { name: "window", act: narrow },
  { name: "replay-window", replay: true, act: narrow },
];

for (const resize of RESIZES)
  test(`the picture stays while the stage resizes: ${resize.name}`, async ({ page, ui }) => {
    if (resize.panels)
      await page.addInitScript(
        ([key, panels]) => localStorage.setItem(key, JSON.stringify(panels)),
        [PANELS, resize.panels] as const,
      );
    if (resize.replay) {
      await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=20000`);
      await ui.picture(page.getByRole("main", { name: "Replay" }).locator(".stage"));
      await page.waitForTimeout(1500);
    } else {
      await ui.open("conversations");
      await livePicture(page);
    }
    const shots = await screencast(page, () => resize.act(page), 1200);
    const shares: number[] = [];
    for (const [n, shot] of shots.entries()) {
      await sharp(shot).toFile(
        test.info().outputPath(`${resize.name}-${String(n).padStart(3, "0")}.png`),
      );
      shares.push(await lit(shot));
    }
    await test.info().attach("lit", { body: shares.map((share) => share.toFixed(2)).join(" ") });
    expect(shots.length).toBeGreaterThan(10);
    // Not one frame without the picture.
    expect(shares.filter((share) => share < 0.1)).toEqual([]);
  });

interface Look {
  id: string;
  scale: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// Each mark of the collapsed rail as it shows now, and how much of each name shows.
const looks = (page: Page) =>
  rail(page)
    .locator(".sessions-item")
    .evaluateAll((rows) =>
      rows.map((row) => {
        const box = row.getBoundingClientRect();
        return {
          id: row.getAttribute("data-flip") ?? "",
          scale: Number.parseFloat((row as HTMLElement).style.scale) || 1,
          top: box.top,
          bottom: box.bottom,
          left: box.left,
          right: box.right,
        };
      }),
    );
const names = (page: Page) =>
  page
    .locator(".sessions-dock-name")
    .evaluateAll((labels) =>
      Object.fromEntries(
        labels.map((label) => [
          label.getAttribute("data-dock-name") ?? "",
          Number(getComputedStyle(label).opacity),
        ]),
      ),
    );
const middleOf = (look: { top: number; bottom: number }) => (look.top + look.bottom) / 2;
// Where the pointer goes for mark `n`: its middle at rest.
const pointerY = (rest: readonly Look[], n: number) => middleOf(rest[n] as Look);

async function marks(page: Page) {
  const rows = rail(page).locator(".sessions-item");
  await expect(rows).toHaveCount(7);
  return looks(page);
}

// The collapsed rail under the mouse, magnified as the Dock is, with the nearby names beside it.
for (const appearance of ["graphite", "midnight", "daylight"] as const)
  test(`the collapsed rail magnifies under the mouse in ${appearance}`, async ({ page, ui }) => {
    await page.addInitScript((choice) => {
      localStorage.setItem("localdot.appearance.v1", choice);
    }, appearance);
    await ui.open("conversations");
    await livePicture(page);
    const rest = await marks(page);
    const x = ((rest[0]?.left ?? 0) + (rest[0]?.right ?? 0)) / 2;
    for (const [name, n] of [
      ["top", 0],
      ["middle", 3],
      ["bottom", 6],
    ] as const) {
      await page.mouse.move(x, pointerY(rest, n), { steps: 4 });
      await page.waitForTimeout(500);
      await page.screenshot({
        path: test.info().outputPath(`${appearance}-${name}.png`),
        clip: { x: 0, y: 0, width: 520, height: 560 },
      });
      const shown = await looks(page);
      const under = shown.findIndex(
        (look) => look.top <= pointerY(rest, n) && pointerY(rest, n) < look.bottom,
      );
      // The mark under the pointer is the largest, and its neighbours shrink away from it.
      expect(Math.max(...shown.map((look) => look.scale))).toBe(shown[under]?.scale);
      expect(shown[under]?.scale).toBeGreaterThan(1.6);
      for (let k = 1; k < shown.length; k++)
        expect(shown[k]?.top).toBeGreaterThanOrEqual((shown[k - 1]?.bottom ?? 0) - 0.5);
      const seen = await names(page);
      expect(seen[shown[under]?.id ?? ""]).toBe(1);
      const away = shown.map((look, k) => [Math.abs(k - under), seen[look.id] ?? 0] as const);
      for (const [distance, opacity] of away)
        for (const [further, less] of away)
          if (further > distance) expect(less).toBeLessThanOrEqual(opacity);
    }
  });

test("follows the mouse on every frame, eases in and out, and a click takes up the mark it shows", async ({
  page,
  ui,
}) => {
  await ui.open("conversations");
  await livePicture(page);
  const rest = await marks(page);
  const x = ((rest[0]?.left ?? 0) + (rest[0]?.right ?? 0)) / 2;
  await page.evaluate(() => {
    const seen: { t: number; scales: number[] }[] = [];
    (window as unknown as { dock_: typeof seen }).dock_ = seen;
    const tick = (t: number) => {
      seen.push({
        t,
        scales: [...document.querySelectorAll<HTMLElement>(".sessions-item")].map(
          (row) => Number.parseFloat(row.style.scale) || 1,
        ),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const shots = await screencast(
    page,
    async () => {
      await page.mouse.move(x + 200, pointerY(rest, 0));
      await page.mouse.move(x, pointerY(rest, 0), { steps: 3 });
      await page.waitForTimeout(250);
      for (let step = 1; step <= 24; step++) {
        await page.mouse.move(
          x,
          pointerY(rest, 0) + (step / 24) * (pointerY(rest, 6) - pointerY(rest, 0)),
        );
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(250);
      await page.mouse.move(x + 400, pointerY(rest, 6), { steps: 3 });
    },
    700,
  );
  for (const [n, shot] of shots.entries())
    await sharp(shot)
      .extract({ left: 0, top: 80, width: 420, height: 420 })
      .toFile(test.info().outputPath(`sweep-${String(n).padStart(3, "0")}.png`));
  const ticks = await page.evaluate(() =>
    (window as unknown as { dock_: { t: number; scales: number[] }[] }).dock_.splice(0),
  );
  const largest = ticks.map((tick) => Math.max(...tick.scales));
  const entered = largest.findIndex((scale) => scale > 1);
  // It eases in over several frames rather than jumping, never overshoots, and lets go of every
  // mark once the mouse leaves.
  expect(largest[entered]).toBeLessThan(1.3);
  expect(Math.max(...largest)).toBeLessThanOrEqual(1.75 + 1e-3);
  expect(largest.at(-1)).toBe(1);
  const top = largest.indexOf(Math.max(...largest));
  const out = largest.findIndex((scale, n) => n > top && scale === 1);
  expect(ticks[out]?.t ?? 0).toBeGreaterThan((ticks[top]?.t ?? 0) + 100);

  // A press lands on the mark shown under the pointer.
  await page.mouse.move(x, pointerY(rest, 5), { steps: 3 });
  await page.waitForTimeout(400);
  const shown = await looks(page);
  const under = shown.find(
    (look) => look.top <= pointerY(rest, 5) && pointerY(rest, 5) < look.bottom,
  );
  expect(under?.scale).toBeGreaterThan(1.6);
  const continued = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/conversation/continue",
  );
  await page.mouse.down();
  await page.mouse.up();
  expect((await continued).postDataJSON()).toEqual({ sessionId: under?.id });
});

test("keeps the grown marks in view where the list scrolls", async ({ page, ui }) => {
  await page.setViewportSize({ width: 1440, height: 320 });
  await ui.open("conversations");
  await livePicture(page);
  const scroller = rail(page).locator(".sessions-scroll");
  const box = await scroller.boundingBox();
  if (!box) throw new Error("no list");
  const rest = await marks(page);
  const inView = rest.filter((look) => look.top >= box.y && look.bottom <= box.y + box.height);
  expect(inView.length).toBeLessThan(rest.length);
  const x = ((rest[0]?.left ?? 0) + (rest[0]?.right ?? 0)) / 2;
  for (const [name, look] of [
    ["first", inView[0]],
    ["last", inView.at(-1)],
  ] as const) {
    if (!look) throw new Error("no mark in view");
    await page.mouse.move(x, middleOf(look), { steps: 3 });
    await page.waitForTimeout(500);
    const grown = (await looks(page)).find((each) => each.id === look.id);
    expect(grown?.scale).toBeGreaterThan(1.5);
    expect(grown?.top).toBeGreaterThanOrEqual(box.y - 0.5);
    expect(grown?.bottom).toBeLessThanOrEqual(box.y + box.height + 0.5);
    await page.screenshot({
      path: test.info().outputPath(`scrolling-${name}.png`),
      clip: { x: 0, y: 0, width: 520, height: 320 },
    });
  }
});

// The fixture's conversations six times over, each copy with ids and a name of its own, so the
// collapsed rail's list scrolls at full height.
async function longList(page: Page) {
  const copy = (id: string, n: number) => `${id.slice(0, 23)}Z${String(n).padStart(2, "0")}`;
  await page.route("**/api/conversations", async (route) => {
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    const list = await reply.json();
    const conversations = list.conversations as { sessionId: string; sessions: string[] }[];
    await route.fulfill({
      json: {
        ...list,
        conversations: [0, 1, 2, 3, 4, 5].flatMap((n) =>
          conversations.map((entry) =>
            n === 0
              ? entry
              : {
                  ...entry,
                  sessionId: copy(entry.sessionId, n),
                  sessions: entry.sessions.map((id) => copy(id, n)),
                  title: `Copy ${n} of ${entry.sessionId.slice(-4)}`,
                },
          ),
        ),
      },
    });
  });
}

// Each mark painted a colour of its own, so a frame shows where every mark is.
const paint = (page: Page) =>
  rail(page)
    .locator(".sessions-item")
    .evaluateAll((rows) => {
      for (const [n, row] of rows.entries())
        (row as HTMLElement).style.backgroundColor = `rgb(${200 - 4 * n}, ${40 + 4 * n}, 255)`;
    });

// The painted marks down the column at `x` of a frame, from `from` to `to`: each one's place in
// the list, its top and how tall it shows.
async function painted(png: Buffer, x: number, from: number, to: number) {
  const { data, info } = await sharp(png)
    .extract({ left: x, top: from, width: 1, height: to - from })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const runs: { n: number; top: number; height: number }[] = [];
  for (let y = 0; y < info.height; y++) {
    const [r = 0, g = 0, b = 0] = data.subarray(y * info.channels, y * info.channels + 3);
    const n = Math.round((200 - r) / 4);
    if (b < 250 || Math.abs(40 + 4 * n - g) > 1 || Math.abs(200 - 4 * n - r) > 1) continue;
    const last = runs.at(-1);
    if (last?.n === n && last.top + last.height >= from + y - 1)
      last.height = from + y + 1 - last.top;
    else runs.push({ n, top: from + y, height: 1 });
  }
  return runs;
}

test("scrolls under the lens at any speed, the marks moving with the list and the lens on what passes under it", async ({
  page,
  ui,
}) => {
  await longList(page);
  await ui.open("conversations");
  await livePicture(page);
  const rows = rail(page).locator(".sessions-item");
  await expect(rows).toHaveCount(42);
  await paint(page);
  const scroller = rail(page).locator(".sessions-scroll");
  const box = await scroller.boundingBox();
  if (!box) throw new Error("no list");
  const atRest = await scroller.evaluate((element) => {
    element.scrollTop = 200;
    return { height: element.scrollHeight, end: element.scrollHeight - element.clientHeight };
  });
  const rest = await looks(page);
  const x = ((rest[0]?.left ?? 0) + (rest[0]?.right ?? 0)) / 2;
  const y = Math.round(box.y + box.height / 2);
  await page.mouse.move(x, y, { steps: 4 });
  await page.waitForTimeout(600);

  // The list as the page shows it after each frame's scroll, read once the lens has placed the
  // marks for it.
  await scroller.evaluate((element) => {
    const seen: { top: number; marks: { top: number; bottom: number }[] }[] = [];
    (window as unknown as { scrolled_: typeof seen }).scrolled_ = seen;
    element.addEventListener("scroll", () =>
      requestAnimationFrame(() =>
        seen.push({
          top: element.scrollTop,
          marks: [...element.querySelectorAll(".sessions-item")].map((row) => {
            const { top, bottom } = row.getBoundingClientRect();
            return { top, bottom };
          }),
        }),
      ),
    );
  });
  let small = 0;
  const shots = await screencast(
    page,
    async () => {
      const from = await scroller.evaluate((element) => element.scrollTop);
      // A trackpad's slow drag, two pixels at a time; a quicker swipe, a few pixels every frame;
      // then a mouse wheel's notches.
      for (let n = 0; n < 12; n++) {
        await page.mouse.wheel(0, 2);
        await page.waitForTimeout(24);
      }
      await page.waitForTimeout(200);
      small = (await scroller.evaluate((element) => element.scrollTop)) - from;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.synthesizeScrollGesture", {
        x,
        y,
        yDistance: -200,
        speed: 600,
        gestureSourceType: "mouse",
      });
      await cdp.detach();
      await page.waitForTimeout(200);
      for (let n = 0; n < 3; n++) {
        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(60);
      }
    },
    500,
  );
  const from = Math.round(box.y) + 18;
  const to = Math.round(box.y + box.height) - 18;
  const columns: Awaited<ReturnType<typeof painted>>[] = [];
  for (const [n, shot] of shots.entries()) {
    await sharp(shot)
      .extract({ left: 0, top: 0, width: 420, height: 900 })
      .toFile(test.info().outputPath(`scroll-${String(n).padStart(3, "0")}.png`));
    columns.push(await painted(shot, Math.round(rest[0]?.left ?? 8) + 4, from, to));
  }
  await test.info().attach("marks per frame", {
    body: columns.map((runs) => runs.map((run) => `${run.n}@${run.top}`).join(" ")).join("\n"),
  });
  // Every small step scrolled the list.
  expect(small).toBeGreaterThanOrEqual(23);

  const frames = (
    await page.evaluate(() =>
      (
        window as unknown as {
          scrolled_: { top: number; marks: { top: number; bottom: number }[] }[];
        }
      ).scrolled_.splice(0),
    )
  ).filter((frame, n, all) => n === 0 || frame.top !== all[n - 1]?.top);
  expect(frames.length).toBeGreaterThan(10);
  // From frame to frame, the marks beyond the lens move up the page exactly as far as the list
  // scrolled: none holds still, none jumps back.
  for (let n = 1; n < frames.length; n++) {
    const was = frames[n - 1];
    const now = frames[n];
    if (!was || !now) continue;
    for (const [k, mark] of now.marks.entries()) {
      const before = was.marks[k];
      if (!before || [mark, before].some((each) => Math.abs(middleOf(each) - y) < 220)) continue;
      if (mark.bottom < box.y || before.top > box.y + box.height) continue;
      expect(mark.top - before.top).toBeCloseTo(was.top - now.top, 0);
    }
  }

  expect(shots.length).toBeGreaterThan(10);
  let moving = 0;
  for (const [n, runs] of columns.entries()) {
    // No blank frame: the list shows in every one.
    expect(runs.length, `marks in frame ${n}`).toBeGreaterThan(8);
    // And no mark ever moves back down the page while the list scrolls on.
    const moved = runs.flatMap((run) => {
      const before = columns[n - 1]?.find((each) => each.n === run.n);
      return before && before.top > from && run.top > from ? [run.top - before.top] : [];
    });
    for (const step of moved) expect(step, `a mark in frame ${n}`).toBeLessThanOrEqual(1);
    if (moved.some((step) => step < 0)) moving++;
  }
  // The list moves on the page with every small step and every frame of the swipe, rather than
  // holding still and then jumping.
  expect(moving).toBeGreaterThan(20);

  // The lens is on the mark the list brought under the pointer.
  await page.waitForTimeout(400);
  const shown = await looks(page);
  const under = shown.find((look) => look.top <= y && y < look.bottom);
  expect(under?.scale).toBeGreaterThan(1.6);
  expect(Math.max(...shown.map((look) => look.scale))).toBe(under?.scale);

  // At the end of the list the lens adds no room to scroll into.
  for (let n = 0; n < 4; n++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(300);
  expect(
    await scroller.evaluate((element) => ({
      height: element.scrollHeight,
      end: element.scrollTop,
    })),
  ).toEqual(atRest);
});

test.describe("under reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("names only the mark under the mouse or reached from the keyboard, and grows none", async ({
    page,
    ui,
  }) => {
    await ui.open("conversations");
    await livePicture(page);
    const rest = await marks(page);
    const x = ((rest[0]?.left ?? 0) + (rest[0]?.right ?? 0)) / 2;
    await page.mouse.move(x, pointerY(rest, 3), { steps: 3 });
    await page.waitForTimeout(400);
    expect((await looks(page)).map((look) => look.scale)).toEqual(rest.map(() => 1));
    const hovered = rest[3]?.id ?? "";
    await expect
      .poll(() => names(page))
      .toEqual(Object.fromEntries(rest.map((look) => [look.id, look.id === hovered ? 1 : 0])));
    await page.screenshot({
      path: test.info().outputPath("reduced-hover.png"),
      clip: { x: 0, y: 0, width: 520, height: 560 },
    });

    // From the keyboard, the mark reached shows its name; the mouse has gone.
    await page.mouse.move(x + 600, 600);
    await rail(page).locator("[aria-current='true']").focus();
    await page.keyboard.press("ArrowDown");
    const focused = await page.evaluate(
      () => document.activeElement?.closest("[data-flip]")?.getAttribute("data-flip") ?? "",
    );
    expect(focused).toBe(rest[1]?.id);
    await expect
      .poll(() => names(page))
      .toEqual(Object.fromEntries(rest.map((look) => [look.id, look.id === focused ? 1 : 0])));
    await page.screenshot({
      path: test.info().outputPath("keyboard.png"),
      clip: { x: 0, y: 0, width: 520, height: 560 },
    });
  });
});
