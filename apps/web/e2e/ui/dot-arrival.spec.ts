import type { Page } from "@playwright/test";
import type { ViewStyle } from "../../src/shell/view-style.ts";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");

// Four sources that would each dress dot differently, answering one after another, and plates that
// come in one at a time: the worst order a slow link can give.
const OWN = { persona: "research", accessory: "bow" };
const TASK_DOT = "design";
const CHOSEN = ["wizard-hat", "sunglasses"];
const FINAL: Record<ViewStyle, string> = {
  chat: "sunglasses wizard-hat",
  studio: "sunglasses wizard-hat",
};

interface Recording {
  // Each look the live dot showed, in order, from the page's first frame.
  live: string[];
  // Each look a list's dot showed, per row.
  rows: Record<string, string[]>;
  // Each look the dot over "Loading your conversations" showed.
  loader: string[];
  // A plate settled into place, as a change of outfit does.
  arrived: number;
}

declare global {
  interface Window {
    arrival_: Recording;
  }
}

function record() {
  const seen: Recording = { live: [], rows: {}, loader: [], arrived: 0 };
  window.arrival_ = seen;
  // An image given a new size keeps drawing what it has until the new file is in.
  const loaded = new WeakSet<HTMLImageElement>();
  const painted = (img: HTMLImageElement) => {
    if (img.complete && img.naturalWidth > 0) loaded.add(img);
    return loaded.has(img) && getComputedStyle(img).visibility !== "hidden";
  };
  // What a dot shows now: the plates really drawn. Nothing, while only a plain stand-in is there.
  const lookOf = (dot: Element, body: string) => {
    const plate = dot.querySelector<HTMLImageElement>(body);
    if (!plate || !painted(plate)) return null;
    return [...dot.querySelectorAll<HTMLImageElement>(".dot-wear:not([data-leaving])")]
      .filter(painted)
      .map((img) => img.dataset.wear)
      .sort()
      .join(" ");
  };
  const note = (list: string[], look: string | null) => {
    if (look !== null && list.at(-1) !== look) list.push(look);
  };
  const tick = () => {
    const frame = document.querySelector<HTMLElement>(".presence-frame");
    if (frame && frame.dataset.shown !== undefined) {
      note(seen.live, lookOf(frame, ".dot-plate-neutral"));
      if (frame.querySelector(".dot-wear[data-arriving]")) seen.arrived++;
    }
    const loader = document.querySelector(".dot-loader .dot");
    if (loader) note(seen.loader, lookOf(loader, ".dot-plate-neutral"));
    for (const avatar of document.querySelectorAll(".conversation-avatar")) {
      const row = avatar.closest("[data-session], li")?.textContent?.slice(0, 40) ?? "";
      seen.rows[row] ??= [];
      note(seen.rows[row], lookOf(avatar, ".dot-plate"));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function slowSources(page: Page) {
  await page.route("**/api/agent/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await later(300);
    const reply = await route.fetch();
    return route.fulfill({ response: reply, json: { ...(await reply.json()), ...OWN } });
  });
  await page.route("**/api/conversations", async (route) => {
    await later(900);
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    const { conversations, ...rest } = await reply.json();
    return route.fulfill({
      response: reply,
      json: {
        ...rest,
        conversations: conversations.map((entry: object, at: number) =>
          at === 0 ? { ...entry, look: CHOSEN } : entry,
        ),
      },
    });
  });
  await page.route("**/api/sessions/*/history", async (route) => {
    await later(600);
    const reply = await route.fetch();
    const lines = (await reply.text()).split("\n").map((line) => {
      if (!/"(session\.start|persona\.choice)"/.test(line)) return line;
      const event = JSON.parse(line);
      return JSON.stringify({ ...event, data: { ...event.data, persona: TASK_DOT } });
    });
    return route.fulfill({ response: reply, body: lines.join("\n") });
  });
  let turn = 0;
  await page.route("**/*.webp", async (route) => {
    await later(40 + 90 * (turn++ % 5));
    return route.continue();
  });
}

// What was shown, once the page has opened, dot has its final look, if it is to have one on this
// screen, and a little longer has gone by for anything that would come after.
async function settled(page: Page, final?: string) {
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  if (final)
    await expect
      .poll(() => page.evaluate(() => window.arrival_.live.at(-1)), { timeout: 20_000 })
      .toBe(final);
  await later(1500);
  return page.evaluate(() => window.arrival_);
}

function expectOneLook(recording: Recording, final: string) {
  expect(recording.live, "every look the live dot showed").toEqual([final]);
  expect(recording.arrived, "frames of an outfit settling into place").toBe(0);
  expect(
    Object.entries(recording.rows).filter(([, looks]) => looks.length > 1),
    "rows whose dot showed more than one look",
  ).toEqual([]);
}

for (const style of ["chat", "studio"] as const) {
  test.describe(style, () => {
    test.use({ viewStyle: style, fixedClock: false });

    test("dot arrives once, wearing its final look", async ({ page, ui }) => {
      await page.addInitScript(record);
      await slowSources(page);
      await ui.open("conversations");
      if (style === "chat") {
        await page.waitForFunction(() => !window.location.hash.includes("token="));
        await page.evaluate(() => {
          window.location.hash = "#/c/current";
        });
      }

      // A first visit has nothing to remember: dot waits until it knows.
      expectOneLook(await settled(page, FINAL[style]), FINAL[style]);

      // A reload.
      await page.reload();
      const again = await settled(page, FINAL[style]);
      expectOneLook(again, FINAL[style]);
      expect(again.loader.length, "looks of the dot over a loading list").toBeLessThanOrEqual(1);
    });

    test("a look remembered wrongly gives way with no hop", async ({ page, ui }) => {
      await page.addInitScript(record);
      await slowSources(page);
      await page.addInitScript(
        ([key, view]) => {
          if (!sessionStorage.getItem("seeded"))
            localStorage.setItem(
              key as string,
              JSON.stringify({ worn: [], shown: { view, task: null, look: ["crown"] } }),
            );
          sessionStorage.setItem("seeded", "1");
        },
        ["localdot.dot-look.v1", style],
      );
      await ui.open("conversations");
      if (style === "chat") {
        await page.waitForFunction(() => !window.location.hash.includes("token="));
        await page.evaluate(() => {
          window.location.hash = "#/c/current";
        });
      }
      const { live, arrived } = await settled(page, FINAL[style]);
      expect(live).toEqual(["crown", FINAL[style]]);
      expect(arrived).toBe(0);
    });
  });
}

test.describe("Replay", () => {
  test.use({ viewStyle: "studio", fixedClock: false });

  test("opening on a recording, dot arrives once, in its task's look", async ({ page, ui }) => {
    await page.addInitScript(record);
    await slowSources(page);
    await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=20000`);
    const shown = () => page.evaluate(() => window.arrival_.live.length);
    await expect.poll(shown, { timeout: 20_000 }).toBeGreaterThan(0);
    const { live } = await settled(page);
    expect(live).toHaveLength(1);
    await page.reload();
    await expect.poll(shown, { timeout: 20_000 }).toBeGreaterThan(0);
    expect((await settled(page, live[0])).live).toEqual(live);
  });
});

test.describe("Chat's list", () => {
  test.use({ viewStyle: "chat", phoneList: true, fixedClock: false });

  test("the rows' dots come in whole, and dot wakes in its look", async ({ page, ui }) => {
    await page.addInitScript(record);
    await slowSources(page);
    await ui.open("conversations");
    const first = await settled(page);
    expect(Object.keys(first.rows).length).toBeGreaterThan(1);
    expect(first.arrived).toBe(0);
    expect(first.live.length).toBeLessThanOrEqual(1);
    await page.reload();
    const again = await settled(page);
    expect(again.live.length).toBeLessThanOrEqual(1);
    expect(again.loader.length).toBeLessThanOrEqual(1);
    expect(
      Object.entries(again.rows).filter(([, looks]) => looks.length > 1),
      "rows whose dot showed more than one look",
    ).toEqual([]);
  });
});
