import { writeFileSync } from "node:fs";
import type { Locator, Page, Route } from "@playwright/test";
import sharp from "sharp";
import { chatRail, expect, isPhone, runAt, test } from "./harness.ts";

// Taking up another conversation goes straight from the screen on show to a calm loading state and
// then into the conversation's own screen: never the curtain, nor the computer's raw desktop or the
// screen left behind under the new conversation. Chromium only: frames come from its screencast.
runAt("c14", "c39");
test.use({ fixedClock: false, reducedMotion: "no-preference" });

const PAST = /Compare flights to Lisbon/;
const OTHER_PAST = /Clean up my Downloads/;
// How long the taken-up conversation's history takes to read, so its screen is late enough to see.
const HISTORY_MS = 1500;

const control = (page: Page, origin: string) => async (path: string) => {
  const reply = await page.request.post(`${origin}/__qa/${path}`);
  expect(reply.ok(), await reply.text()).toBe(true);
};

interface Shot {
  t: number;
  png: Buffer;
}
interface Seen {
  t: number;
  curtain: boolean;
  // The loading state's opacity while it shows; null without it.
  cover: number | null;
  leaving: boolean;
  // What the island says, and the screen note under it.
  island: string;
  note: string | null;
  // A sheet is open (the phone's list of conversations), its scrim over the stage.
  over: boolean;
}

// Every frame the compositor makes while `act` runs and for `ms` after it, what the page showed on
// each animation frame meanwhile, and when `act` says it clicked.
async function record(page: Page, act: () => Promise<number>, ms: number) {
  const cdp = await page.context().newCDPSession(page);
  const shots: Shot[] = [];
  cdp.on("Page.screencastFrame", (frame) => {
    shots.push({
      t: (frame.metadata.timestamp ?? 0) * 1000,
      png: Buffer.from(frame.data, "base64"),
    });
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await page.evaluate(() => {
    const seen: unknown[] = [];
    (window as unknown as { seen_: unknown[] }).seen_ = seen;
    const tick = () => {
      const cover = document.querySelector(".switch-cover");
      seen.push({
        t: Date.now(),
        curtain: !!document.querySelector(".curtain"),
        cover: cover ? Number(getComputedStyle(cover).opacity) : null,
        leaving: !!cover?.closest("[data-leaving]"),
        island: document.querySelector(".island-row")?.textContent ?? "",
        note: document.querySelector(".ui-toast-title")?.textContent ?? null,
        over: !!document.querySelector("[role='dialog'], .ui-sheet-layer, .ui-scrim"),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await page.waitForTimeout(300);
  const from = Date.now();
  const at = await act();
  await page.waitForTimeout(ms);
  await cdp.send("Page.stopScreencast");
  await cdp.detach();
  const seen = (await page.evaluate(() =>
    (window as unknown as { seen_: unknown[] }).seen_.splice(0),
  )) as Seen[];
  // The frames a sheet lay over the stage in, give or take one, say nothing of the stage.
  const covered = seen.filter((each) => each.over).map((each) => each.t);
  const visible = (t: number) =>
    !covered.length || t < (covered[0] ?? 0) - 20 || t > (covered.at(-1) ?? 0) + 50;
  return { from, at, shots: shots.filter((shot) => visible(shot.t)), seen, shown: covered.at(-1) };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

async function stageBox(page: Page): Promise<Box> {
  const box = await page.locator(".stage-box").first().boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error("no stage");
  return { ...box, page: viewport.width };
}

// The stage's picture in a frame, small: RGB at 48 × 30.
async function stageLook(box: Box, png: Buffer): Promise<Float64Array> {
  const { width = box.page } = await sharp(png).metadata();
  const k = width / box.page;
  // Inside the rim, under the island and the notes that hang from it, and above the controls in
  // the stage's bottom corners, which come and go by themselves.
  const inset = 6;
  const top = 64;
  const bottom = 64;
  const raw = await sharp(png)
    .extract({
      left: Math.round((box.x + inset) * k),
      top: Math.round((box.y + top) * k),
      width: Math.round((box.width - 2 * inset) * k),
      height: Math.round((box.height - top - bottom) * k),
    })
    .resize(48, 30, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
  return Float64Array.from(raw);
}

const distance = (a: Float64Array, b: Float64Array) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += ((a[i] ?? 0) - (b[i] ?? 0)) ** 2;
  return Math.sqrt(sum);
};

// The frame as a mix of two looks, `a` to `b` by `t`, and how much of it the mix leaves out.
function mix(frame: Float64Array, a: Float64Array, b: Float64Array) {
  let along = 0;
  let span = 0;
  for (let i = 0; i < frame.length; i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    along += ((frame[i] ?? 0) - (a[i] ?? 0)) * d;
    span += d * d;
  }
  const t = span ? Math.min(1, Math.max(0, along / span)) : 0;
  let rest = 0;
  for (let i = 0; i < frame.length; i++) {
    const fit = (a[i] ?? 0) + t * ((b[i] ?? 0) - (a[i] ?? 0));
    rest += ((frame[i] ?? 0) - fit) ** 2;
  }
  return { t, rest: Math.sqrt(rest) };
}

const LOOKS = ["old", "cover", "new"] as const;
type LookName = (typeof LOOKS)[number];

// The loading state before its likeness of a screen fades in: its surface alone, the colour most of
// it is.
function bare(cover: Float64Array): Float64Array {
  const surface = [0, 1, 2].map((channel) => {
    const values = cover.filter((_, i) => i % 3 === channel).sort();
    return values[Math.floor(values.length / 2)] ?? 0;
  });
  return cover.map((_, i) => surface[i % 3] ?? 0);
}

// Each frame from the click on, read as the screen left behind, the loading state (with or without
// its likeness of a screen), the screen taken up or a crossfade between two of them; `rest` is what
// none of them explains, against how far the two screens are apart.
function readFrames(
  frames: { n: number; t: number; look: Float64Array }[],
  looks: Record<LookName, Float64Array>,
) {
  const scale = distance(looks.old, looks.new);
  const named: [LookName, Float64Array][] = [
    ["old", looks.old],
    ["cover", bare(looks.cover)],
    ["cover", looks.cover],
    ["new", looks.new],
  ];
  return frames.map(({ n, t, look }) => {
    let best = { rest: Number.POSITIVE_INFINITY, main: "old" as LookName };
    for (const [i, [nameA, a]] of named.entries())
      for (const [nameB, b] of named.slice(i + 1)) {
        const { t: share, rest } = mix(look, a, b);
        if (rest < best.rest) best = { rest, main: share < 0.5 ? nameA : nameB };
      }
    return { n, t, main: best.main, rest: best.rest / scale };
  });
}

// Takes up the conversation from its row, in the rail or, on a phone, in the list's sheet, which
// it opens first; `then` runs just before the click. Returns when it clicked.
async function take(page: Page, title: RegExp, then = () => {}) {
  let row: Locator;
  if (isPhone(page)) {
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    row = page
      .getByRole("dialog", { name: "Conversations" })
      .getByRole("button", { name: title })
      .filter({ hasNotText: "Actions" })
      .first();
    await expect(row).toBeVisible();
    await page.waitForTimeout(500);
  } else
    row = page
      .getByRole("navigation", { name: "Conversations" })
      .getByRole("button", { name: title })
      .first();
  then();
  const at = Date.now();
  // On a desktop the row is taken up without the pointer over the rail, whose magnified names
  // would lie over the stage while they fade (rail-motion covers a pointer's click).
  if (isPhone(page)) await row.click();
  else await row.dispatchEvent("click");
  return at;
}

async function livePicture(page: Page) {
  await expect(page.locator(".stage.lit").first()).toBeVisible();
  await expect(page.locator(".curtain")).toHaveCount(0);
  await expect
    .poll(() => page.locator(".stage canvas").first().getAttribute("data-frames"))
    .not.toBe("0");
  await page.waitForTimeout(1500);
}

// A task under way in the conversation on show, at work in the web browser, which the list of
// conversations says is under way, as the daemon's runner does.
async function browserTask(page: Page, origin: string) {
  const qa = control(page, origin);
  const rail = await chatRail(page);
  const form = rail.getByRole("form", { name: "Message dot" });
  await form.getByRole("textbox").fill("Check the orders");
  await form.getByRole("button", { name: /^(Start task|Send|Send follow-up)$/ }).click();
  await expect(rail.getByText("Check the orders")).toBeVisible();
  const state = await (await page.request.get(`${origin}/__qa/state`)).json();
  const live = state.sessionId as string;
  await page.route("**/api/conversations", async (route) => {
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    const list = await reply.json();
    await route.fulfill({
      json: {
        ...list,
        conversations: list.conversations.map((entry: { sessionId: string }) =>
          entry.sessionId === live
            ? {
                ...entry,
                ended: null,
                live: { state: "working", since: new Date().toISOString(), onScreen: true },
              }
            : entry,
        ),
      },
    });
  });
  await qa("screen?to=browser");
  await page.waitForTimeout(2500);
  return live;
}

async function inEachAppearance(page: Page, name: string) {
  for (const appearance of ["graphite", "midnight", "daylight"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await page.waitForTimeout(200);
    await page.screenshot({ path: test.info().outputPath(`${name}-${appearance}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.appearance = "graphite";
  });
}

// From the click on, the conversation's history is read late, or (`hold`) not at all until let go.
async function lateHistory(page: Page, hold = false) {
  const held: Route[] = [];
  let on = false;
  await page.route("**/api/sessions/*/history*", async (route) => {
    if (!on) return route.continue();
    if (hold) {
      held.push(route);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, HISTORY_MS));
    await route.continue().catch(() => {});
  });
  return {
    start: () => {
      on = true;
    },
    release: async () => {
      on = false;
      for (const route of held.splice(0)) await route.continue().catch(() => {});
    },
  };
}

// Records taking up `title` and checks every frame between the screen left behind and the one taken
// up: the loading state comes at once, holds until the screen is in and gives way to it, with nothing
// else in between.
async function switchCleanly(page: Page, name: string, title: RegExp, late: () => void) {
  const box = await stageBox(page);
  const run = await record(page, () => take(page, title, late), HISTORY_MS + 2000);
  const frames = [];
  for (const [n, shot] of run.shots.entries()) {
    await sharp(shot.png).toFile(
      test.info().outputPath(`${name}-${String(n).padStart(3, "0")}.png`),
    );
    frames.push({ n, t: shot.t, look: await stageLook(box, shot.png) });
  }
  // The loading state at rest, half way through the wait.
  const up = run.seen.filter((seen) => seen.cover === 1 && !seen.leaving);
  expect(up.length, "the loading state shows").toBeGreaterThan(10);
  const middle = up[Math.floor(up.length / 2)]?.t ?? 0;
  const atCover = frames.reduce((near, frame) =>
    Math.abs(frame.t - middle) < Math.abs(near.t - middle) ? frame : near,
  );
  const before = frames.filter((frame) => frame.t < run.at);
  // On a phone the screen is first seen again as the sheet leaves.
  const shownAt = Math.max(run.at, run.shown ?? 0);
  const looks = {
    old: before.at(-1)?.look ?? new Float64Array(),
    cover: atCover.look,
    new: frames.at(-1)?.look ?? new Float64Array(),
  };
  const read = readFrames(
    frames.filter((frame) => frame.t >= run.at),
    looks,
  );
  writeFileSync(
    test.info().outputPath(`${name}-frames.txt`),
    read
      .map(
        (frame) =>
          `${frame.n} ${Math.round(frame.t - run.at)} ms ${frame.main} ${frame.rest.toFixed(3)}`,
      )
      .join("\n"),
  );
  let said = "";
  const changes: string[] = [];
  for (const { t, ...rest } of run.seen) {
    const now = JSON.stringify({ ...rest, cover: rest.cover?.toFixed(2) ?? null });
    if (now !== said) changes.push(`${Math.round(t - run.at)} ms ${now}`);
    said = now;
  }
  writeFileSync(test.info().outputPath(`${name}-page.txt`), changes.join("\n"));
  // Never the curtain, nor word that dot moved: the user did.
  expect(run.seen.filter((seen) => seen.curtain)).toEqual([]);
  // (A note from before the click has had time to leave.)
  expect(
    run.seen.filter(
      (seen) => seen.t > run.at + 500 && /dot moved|dot is back/.test(seen.note ?? ""),
    ),
  ).toEqual([]);
  // Every frame is the screen left behind, the loading state, the screen taken up or a crossfade
  // between them: nothing else shows on the way, such as the raw desktop or the computer's home.
  for (const frame of read)
    expect(frame.rest, `frame at ${Math.round(frame.t - run.at)} ms`).toBeLessThan(0.15);
  // And in that order: once the loading state is up, the screen left behind never comes back, and
  // the screen taken up comes only after it.
  const order = read.map((frame) => LOOKS.indexOf(frame.main));
  for (let n = 1; n < order.length; n++)
    expect(order[n], `frame ${n} goes back`).toBeGreaterThanOrEqual(order[n - 1] ?? 0);
  const firstCover = read.find((frame) => frame.main === "cover");
  const firstNew = read.find((frame) => frame.main === "new");
  expect(firstCover && firstNew && firstCover.t < firstNew.t).toBe(true);
  // The screen left behind gives way at once, not after the new conversation is on show.
  expect((firstCover?.t ?? Number.POSITIVE_INFINITY) - shownAt).toBeLessThan(400);
  // The new screen comes only once its history is in.
  expect((firstNew?.t ?? 0) - run.at).toBeGreaterThan(HISTORY_MS - 200);
}

for (const motion of ["no-preference", "reduce"] as const)
  test.describe(`with motion ${motion}`, () => {
    test.use({ reducedMotion: motion });

    test("a switch shows the loading state between two different screens, and nothing else", async ({
      page,
      ui,
    }) => {
      test.setTimeout(120_000);
      const fixture = await ui.open("conversations");
      await livePicture(page);
      await browserTask(page, fixture.origin);
      const late = await lateHistory(page);

      // From dot at work in the web browser to a conversation at rest, which shows the desktop.
      await switchCleanly(page, "to-desktop", PAST, late.start);
      await late.release();
      // The island tells of the conversation taken up, not of a message sent in the other one.
      if (!isPhone(page)) await expect(page.locator(".island-row")).toContainText("Done");
      await expect(page.locator(".switch-cover")).toHaveCount(0);

      // And back: the desktop gives way to the loading state, then the web browser.
      await switchCleanly(
        page,
        "to-browser",
        /Sample · monthly report|Check the orders/,
        late.start,
      );
      await late.release();
      if (motion === "reduce") {
        // Under reduced motion the likeness of a screen stands still.
        await take(page, PAST, late.start);
        const bone = page.locator(".switch-cover .ui-skeleton-bone");
        await expect(bone).toBeVisible();
        expect(await bone.evaluate((element) => getComputedStyle(element).animationName)).toBe(
          "none",
        );
        await late.release();
      }
    });
  });

test("taking up a conversation that shows the picture already on the stage keeps it", async ({
  page,
  ui,
}) => {
  await ui.open("conversations");
  await livePicture(page);
  const box = await stageBox(page);
  for (const [name, title] of [
    ["past", PAST],
    ["other-past", OTHER_PAST],
  ] as const) {
    const run = await record(page, () => take(page, title), 1500);
    expect(run.seen.filter((seen) => seen.cover !== null || seen.curtain)).toEqual([]);
    // The island keeps its word too, rather than blinking through an empty task's.
    expect([...new Set(run.seen.map((seen) => seen.island))]).toEqual([run.seen[0]?.island]);
    const first = await stageLook(box, run.shots[0]?.png ?? Buffer.alloc(0));
    const span = Math.sqrt(first.length) * 255;
    for (const [n, shot] of run.shots.entries()) {
      if (n % 4 === 0)
        await sharp(shot.png).toFile(
          test.info().outputPath(`${name}-${String(n).padStart(3, "0")}.png`),
        );
      // Not a blink: the picture stays as it was.
      expect(distance(await stageLook(box, shot.png), first) / span, `frame ${n}`).toBeLessThan(
        0.03,
      );
    }
  }
});

test("a screen that never comes is said to be late, in every appearance, with the computer a press away", async ({
  page,
  ui,
}) => {
  test.setTimeout(90_000);
  const fixture = await ui.open("conversations");
  await livePicture(page);
  await browserTask(page, fixture.origin);
  const late = await lateHistory(page, true);
  await take(page, PAST, late.start);
  const cover = page.locator(".switch-cover");
  await expect(cover).toBeVisible();
  await expect(cover.locator(".switch-cover-title")).toHaveText(/^Compare flights to Lisbon/);
  await page.waitForTimeout(600);
  await inEachAppearance(page, "loading");
  const message = cover.getByText("This conversation's screen is taking longer than usual");
  await expect(message).toBeVisible({ timeout: 12_000 });
  await expect(cover.getByText("Its picture hasn't come through yet.")).toBeVisible();
  await inEachAppearance(page, "late");
  await cover.getByRole("button", { name: "Show the computer" }).click();
  await expect(cover).toHaveCount(0);
  await late.release();
});
