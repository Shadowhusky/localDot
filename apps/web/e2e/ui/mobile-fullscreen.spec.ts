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

// A short phone gives the band's room to the work while dot works (app.css), which leaves no line.
const bandHidden = (size: Size) => size.width < 700 && size.height < 650;

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
    return;
  }
  const line = bandHidden(size) ? layout.line : present(layout.line, "dot's line");
  if (line) {
    expect(pill.top - line.bottom, "room over the pill").toBeGreaterThanOrEqual(gap);
    expect(left.top - line.bottom, "room over the corner buttons").toBeGreaterThanOrEqual(gap);
    const dot = present(layout.dot, "dot");
    expectWithin(dot, size, insets, "dot");
    expect(line.top, "dot's line under dot").toBeGreaterThanOrEqual(dot.bottom);
  }
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

// The running task in full screen as an iPhone shows it: Safari has no full screen for the page.
async function runningFullScreen(page: Page, ui: Harness) {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: undefined,
    });
  });
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
    if (bandHidden(size)) return;
    const wrapped = present(layout.line, "dot's line");
    expect(wrapped.bottom - wrapped.top, "the long line wraps").toBeGreaterThan(24);
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

test("full screen keeps clear of an iPhone's safe areas", async ({ page, ui, browserName }) => {
  test.skip(browserName !== "chromium", "Safe areas are emulated through Chromium's DevTools");
  const { post, shown } = await runningFullScreen(page, ui);
  await post(`/__qa/say?text=${encodeURIComponent(LONG_LINE)}`);
  await expect(page.locator(".narration-line:not([data-leaving])")).toContainText(LONG_LINE);
  const cdp = await page.context().newCDPSession(page);
  // The status bar and home indicator upright, the notch sideways.
  for (const [size, insets] of [
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
