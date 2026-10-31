import type { Page } from "@playwright/test";
import { expect, type Harness, runAt, test } from "./harness.ts";

runAt("c39", "w39");

for (const fallback of [false, true]) {
  test(`watching a running task can enter and leave full screen${fallback ? " without the browser API" : ""}`, async ({
    page,
    ui,
  }) => {
    if (fallback)
      await page.addInitScript(() => {
        Object.defineProperty(Element.prototype, "requestFullscreen", {
          configurable: true,
          value: undefined,
        });
      });
    await ui.open("running");
    await ui.picture();
    const app = page.locator(".app");
    await expect(app).not.toHaveAttribute("data-entering");
    await ui.settle();
    const expand = page.locator(".stage-expand").getByRole("button", { name: "Full screen" });
    const leave = page.getByRole("button", { name: "Exit full screen" });
    const stream = await page.locator("iframe.desktop-frame").elementHandle();
    expect(stream).not.toBeNull();
    const effects: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/"))
        effects.push(new URL(request.url()).pathname);
    });

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      // Landscape enters focus automatically. Leaving must not prevent a later explicit tap.
      if (viewport.width > viewport.height) {
        await expect(app).toHaveAttribute("data-focus", "");
        await leave.tap();
      }
      for (let repeat = 0; repeat < 2; repeat++) {
        await expect(app).not.toHaveAttribute("data-focus");
        await expect(page.locator(".stage-expand")).toHaveCSS("opacity", "1");
        const target = await expand.boundingBox();
        expect(target?.width).toBeGreaterThanOrEqual(44);
        expect(target?.height).toBeGreaterThanOrEqual(44);
        if (repeat === 0)
          await page.screenshot({ path: test.info().outputPath(`watch-${viewport.width}.png`) });
        await expand.tap();
        await expect(app).toHaveAttribute("data-focus", "");
        await expect(leave).toBeVisible();
        await expect(page.getByRole("form", { name: "Message dot" })).toBeHidden();
        await expect(
          page.locator(".focus-controls").getByRole("button", { name: "Stop", exact: true }),
        ).toBeEnabled();
        await ui.settle();
        await page.screenshot({
          path: test.info().outputPath(`full-${viewport.width}-${repeat}.png`),
        });
        await leave.tap();
        await expect(page.getByRole("form", { name: "Message dot" })).toBeVisible();
      }
    }
    expect(await stream?.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.getByTestId("hud-status")).toHaveText("Select the Net total cell");
    expect(
      effects,
      "fullscreen must not pause, stop, take control, or reconnect the computer",
    ).toEqual([]);
  });
}

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Size {
  width: number;
  height: number;
}

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
// The status pill's room from dot's line and the picture, upright; a phone held sideways keeps the
// island's own gap of 8 in the strip over the picture.
const UPRIGHT_GAP = 12;
const SIDEWAYS_GAP = 8;
// Between the pill and the buttons in the strip's corners.
const CLEARANCE = 8;
const LONG_LINE =
  "Still checking textures and which rig nodes Godot relies on before writing the new build script for the pistol";
const LONG_STEP = "Type the quarterly revenue total into the Net column of the summary sheet";

// What full screen shows around the picture, in CSS pixels; a part not on show is null.
async function focusLayout(page: Page) {
  return page.evaluate(() => {
    const edges = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element?.checkVisibility()) return null;
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    return {
      pill: edges(".island-plate"),
      conversations: edges(".island-conversations"),
      newConversation: edges(".island-new"),
      dot: edges(".narrator-dock"),
      press: edges(".narrator-dot"),
      line: edges(".narration"),
      picture: edges(".stage-box"),
      controls: edges(".focus-controls"),
      hint: edges(".focus-hint"),
    };
  });
}

type FocusLayout = Awaited<ReturnType<typeof focusLayout>>;

function present(edges: Edges | null, name: string): Edges {
  if (!edges) throw new Error(`${name} is not on show`);
  return edges;
}

function expectWithin(edges: Edges, size: Size, insets: Insets, name: string) {
  expect(edges.left, `${name} left`).toBeGreaterThanOrEqual(insets.left - 0.5);
  expect(edges.top, `${name} top`).toBeGreaterThanOrEqual(insets.top - 0.5);
  expect(edges.right, `${name} right`).toBeLessThanOrEqual(size.width - insets.right + 0.5);
  expect(edges.bottom, `${name} bottom`).toBeLessThanOrEqual(size.height - insets.bottom + 0.5);
}

// dot and its line beside the picture, held sideways, inside the screen and its safe areas.
function expectBeside(layout: FocusLayout, size: Size, insets: Insets) {
  const picture = present(layout.picture, "the picture");
  const dot = present(layout.dot, "dot");
  const line = present(layout.line, "dot's line");
  for (const [edges, name] of [
    [dot, "dot"],
    [line, "dot's line"],
  ] as const) {
    expectWithin(edges, size, insets, name);
    expect(edges.right, `${name} left of the picture`).toBeLessThanOrEqual(picture.left);
    expect(edges.top, `${name} level with the picture`).toBeGreaterThanOrEqual(picture.top - 0.5);
    expect(edges.bottom, `${name} level with the picture`).toBeLessThanOrEqual(
      picture.bottom + 0.5,
    );
  }
  expect(line.top, "dot's line under dot").toBeGreaterThanOrEqual(dot.bottom);
}

function expectClearPill(layout: FocusLayout, size: Size, insets: Insets = NO_INSETS) {
  const upright = size.height > size.width;
  const gap = upright ? UPRIGHT_GAP : SIDEWAYS_GAP;
  const pill = present(layout.pill, "the status pill");
  const picture = present(layout.picture, "the picture");
  const corners = [
    present(layout.conversations, "Conversations"),
    present(layout.newConversation, "New conversation"),
  ];
  expectWithin(pill, size, insets, "the status pill");
  for (const corner of corners) {
    expectWithin(corner, size, insets, "a corner button");
    expect(
      Math.abs(corner.top - pill.top),
      "the corner buttons sit level with the pill",
    ).toBeLessThan(1);
  }
  const [left, right] = corners as [Edges, Edges];
  expect(pill.left - left.right, "clear of Conversations").toBeGreaterThanOrEqual(CLEARANCE);
  expect(right.left - pill.right, "clear of New conversation").toBeGreaterThanOrEqual(CLEARANCE);
  expect(picture.top - pill.bottom, "room under the pill").toBeGreaterThanOrEqual(gap);
  if (!upright) {
    expect(pill.top - insets.top, "room over the pill").toBeGreaterThanOrEqual(gap);
    expectBeside(layout, size, insets);
    return;
  }
  // Only a phone too short for any of dot's line shows dot alone.
  const dot = present(layout.dot, "dot");
  expectWithin(dot, size, insets, "dot");
  const above = layout.line ?? dot;
  expect(pill.top - above.bottom, "room over the pill").toBeGreaterThanOrEqual(gap);
  expect(left.top - above.bottom, "room over the corner buttons").toBeGreaterThanOrEqual(gap);
  if (layout.line)
    expect(layout.line.top, "dot's line under dot").toBeGreaterThanOrEqual(dot.bottom);
  const controls = present(layout.controls, "the controls");
  const hint = present(layout.hint, "the hint");
  expect(controls.top - picture.bottom, "room under the picture").toBeGreaterThanOrEqual(gap);
  expect(hint.top, "the hint under the controls").toBeGreaterThanOrEqual(controls.bottom);
  expectWithin(hint, size, insets, "the hint");
}

const PORTRAIT: Size[] = [
  { width: 320, height: 568 },
  { width: 320, height: 700 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 745 },
  { width: 430, height: 932 },
];
const LANDSCAPE: Size[] = [
  { width: 568, height: 320 },
  { width: 844, height: 390 },
  { width: 932, height: 430 },
];
// dot's width and height at each size: on the shortest it gives way to its line, down to 48.
const DOT: Record<string, number> = {
  "320x568": 64,
  "320x700": 111,
  "375x667": 77.3,
  "390x844": 120,
  "430x745": 99.1,
  "430x932": 120,
  "568x320": 79,
  "844x390": 88,
  "932x430": 88,
};

function expectDotSize(
  layout: FocusLayout,
  size: Size,
  expected = DOT[`${size.width}x${size.height}`],
) {
  const dot = present(layout.dot, "dot");
  const name = `dot at ${size.width} × ${size.height}`;
  expect(dot.right - dot.left, name).toBeCloseTo(expected ?? Number.NaN, 0);
  expect(dot.bottom - dot.top, name).toBeCloseTo(expected ?? Number.NaN, 0);
}

// The press on dot covers its ball, the middle three quarters of its frame.
function expectPressOnBall(layout: FocusLayout, size: Size) {
  const dot = present(layout.dot, "dot");
  const press = present(layout.press, "the press on dot");
  const inset = (dot.right - dot.left) / 8;
  const ball = {
    left: dot.left + inset,
    top: dot.top + inset,
    right: dot.right - inset,
    bottom: dot.bottom - inset,
  };
  const across = Math.min(ball.right, press.right) - Math.max(ball.left, press.left);
  const down = Math.min(ball.bottom, press.bottom) - Math.max(ball.top, press.top);
  const covered =
    (Math.max(0, across) * Math.max(0, down)) /
    ((ball.right - ball.left) * (ball.bottom - ball.top));
  expect(covered, `the press on dot's ball at ${size.width} × ${size.height}`).toBeGreaterThan(0.9);
}

// How many lines dot's line shows, as full screen sets them in 1rem each.
const lines = (layout: FocusLayout) =>
  layout.line ? Math.round((layout.line.bottom - layout.line.top) / 16) : 0;

// As an iPhone: Safari has no full screen for the page.
function withoutFullscreenApi(page: Page) {
  return page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: undefined,
    });
  });
}

// The running task in full screen as an iPhone shows it.
async function runningFullScreen(page: Page, ui: Harness) {
  await withoutFullscreenApi(page);
  const fixture = await ui.open("running");
  await ui.picture();
  await ui.settle();
  await page.locator(".stage-expand").getByRole("button", { name: "Full screen" }).tap();
  const app = page.locator(".app");
  await expect(app).toHaveAttribute("data-focus", "");
  const pill = page.locator(".island-anchor");
  return {
    app,
    pill,
    async post(path: string) {
      const reply = await page.request.post(`${fixture.origin}${path}`);
      expect(reply.ok(), await reply.text()).toBe(true);
    },
    // At `size`, with the pill brought back by a touch.
    async shown(size: Size) {
      await page.setViewportSize(size);
      // The page takes the visible height a frame after the viewport changes.
      await expect
        .poll(() => app.evaluate((element) => element.getBoundingClientRect().height))
        .toBe(size.height);
      await page.evaluate(() => document.dispatchEvent(new PointerEvent("pointerdown")));
      await expect(pill).toHaveCSS("opacity", "1");
      await ui.settle();
      return focusLayout(page);
    },
  };
}

test("full screen keeps the status pill clear of the corner buttons, dot's line and the picture", async ({
  page,
  ui,
}) => {
  const { app, pill, post, shown } = await runningFullScreen(page, ui);
  // While dot works, a short phone's band gives way to the thread outside full screen (app.css).
  await expect(page.locator(".thread-work[data-live]")).toBeAttached();
  const line = page.locator(".narration-line:not([data-leaving])");
  const shoot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  const everySize = async (state: string, check?: (layout: FocusLayout, size: Size) => void) => {
    for (const appearance of ["graphite", "daylight"] as const) {
      await page.evaluate((value) => {
        document.documentElement.dataset.appearance = value;
      }, appearance);
      for (const size of [...PORTRAIT, ...LANDSCAPE]) {
        const layout = await shown(size);
        expectClearPill(layout, size);
        expectDotSize(layout, size);
        expectPressOnBall(layout, size);
        check?.(layout, size);
        await shoot(`${state}-${appearance}-${size.width}x${size.height}`);
      }
    }
  };

  await post(`/__qa/say?text=${encodeURIComponent("Backing up the first build script")}`);
  await expect(line).toContainText("Backing up the first build script");
  await everySize("short");

  // A line that wraps, over a step whose name is longer than the pill has room for.
  await post(`/__qa/say?text=${encodeURIComponent(LONG_LINE)}`);
  await post(`/__qa/steps?label=${encodeURIComponent(LONG_STEP)}`);
  await expect(line).toContainText(LONG_LINE);
  await expect(page.locator(".island-label")).toContainText("quarterly revenue total");
  await everySize("long", (layout, size) => {
    expect(lines(layout), "the long line wraps").toBeGreaterThan(1);
    expect(lines(layout), "within its clamp").toBeLessThanOrEqual(size.height > size.width ? 3 : 4);
  });

  // Faded after a still moment, the pill leaves everything around it where it was.
  for (const size of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    const awake = await shown(size);
    await expect(app).toHaveAttribute("data-still", "");
    await expect(pill).toHaveCSS("opacity", "0");
    const still = await focusLayout(page);
    expect(still).toEqual(awake);
    await shoot(`still-${size.width}x${size.height}`);
  }
});

// Shorter than an iPhone SE's screen, as Safari's toolbars leave it: dot keeps 48 and its line gives
// up a line at a time, then goes.
const SHORTER: [Size, number][] = [
  [{ width: 375, height: 548 }, 2],
  [{ width: 320, height: 500 }, 2],
  [{ width: 320, height: 480 }, 1],
  [{ width: 320, height: 454 }, 0],
];

test("full screen on a shorter phone keeps dot and as much of its line as fits", async ({
  page,
  ui,
}) => {
  const { post, shown } = await runningFullScreen(page, ui);
  await post(`/__qa/say?text=${encodeURIComponent(LONG_LINE)}`);
  await expect(page.locator(".narration-line:not([data-leaving])")).toContainText(LONG_LINE);
  for (const appearance of ["graphite", "daylight"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    for (const [size, shownLines] of SHORTER) {
      const layout = await shown(size);
      expectClearPill(layout, size);
      expectDotSize(layout, size, 48);
      expectPressOnBall(layout, size);
      expect(lines(layout), `dot's line at ${size.width} × ${size.height}`).toBe(shownLines);
      await page.screenshot({
        path: test.info().outputPath(`shorter-${appearance}-${size.width}x${size.height}.png`),
      });
    }
  }
});

test("a tap on dot in full screen opens the chooser", async ({ page, ui }) => {
  const { app, shown } = await runningFullScreen(page, ui);
  const chooser = page.getByRole("dialog", { name: "Your dot" });
  for (const size of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    const layout = await shown(size);
    expectPressOnBall(layout, size);
    const dot = present(layout.dot, "dot");
    await page.touchscreen.tap((dot.left + dot.right) / 2, (dot.top + dot.bottom) / 2);
    await expect(chooser).toBeVisible();
    await ui.settle();
    await page.screenshot({
      path: test.info().outputPath(`chooser-${size.width}x${size.height}.png`),
    });
    // A sheet upright on a phone, a popover beside dot on a wider screen held sideways.
    await page.keyboard.press("Escape");
    await expect(chooser).toBeHidden();
    await expect(app).toHaveAttribute("data-focus", "");
  }
});

test("a short phone gives dot's band to the thread while dot works, except in full screen", async ({
  page,
  ui,
}) => {
  await withoutFullscreenApi(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await ui.open("running");
  await ui.picture();
  await ui.settle();
  await expect(page.locator(".thread-work[data-live]")).toBeAttached();
  const band = page.locator(".stage-band");
  await expect(band).toBeHidden();
  await page.locator(".stage-expand").getByRole("button", { name: "Full screen" }).tap();
  await expect(page.locator(".app")).toHaveAttribute("data-focus", "");
  await expect(page.locator(".narrator-dock")).toBeVisible();
  await page.getByRole("button", { name: "Exit full screen" }).tap();
  await expect(page.getByRole("form", { name: "Message dot" })).toBeVisible();
  await expect(band).toBeHidden();
});

test("full screen keeps clear of an iPhone's safe areas", async ({ page, ui, browserName }) => {
  test.skip(browserName !== "chromium", "Safe areas are emulated through Chromium's DevTools");
  const { post, shown } = await runningFullScreen(page, ui);
  await post(`/__qa/say?text=${encodeURIComponent(LONG_LINE)}`);
  await expect(page.locator(".narration-line:not([data-leaving])")).toContainText(LONG_LINE);
  const cdp = await page.context().newCDPSession(page);
  // The status bar and home indicator upright, the notch sideways; an iPhone SE's status bar over
  // the app added to its Home Screen.
  for (const [size, insets] of [
    [
      { width: 320, height: 568 },
      { top: 20, right: 0, bottom: 0, left: 0 },
    ],
    [
      { width: 390, height: 844 },
      { top: 47, right: 0, bottom: 34, left: 0 },
    ],
    [
      { width: 430, height: 932 },
      { top: 59, right: 0, bottom: 34, left: 0 },
    ],
    [
      { width: 844, height: 390 },
      { top: 0, right: 47, bottom: 21, left: 47 },
    ],
  ] as const) {
    await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets } as never);
    const layout = await shown(size);
    expectClearPill(layout, size, insets);
    for (const part of ["dot", "line", "picture", "controls"] as const)
      expectWithin(present(layout[part], part), size, insets, part);
    await page.screenshot({
      path: test.info().outputPath(`safe-${size.width}x${size.height}.png`),
    });
  }
});
