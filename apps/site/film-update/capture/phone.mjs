// Chat on a phone, takes of the real app against the UI fixture, one for each run of screens the film shows:
//   node film-update/capture/phone.mjs [--tall] [--draft] [ask] [card] [tab]
// --tall is the 9:16 cut's: the same phone layout, its height what the frame has room for at a size
// that reads. Where each finger lands goes to phone-touches[-tall].json, and where the elements the film
// points at are to phone-rects[-tall].json.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { startFixture, TOKEN } from "./fixture.mjs";
import { serveGame } from "./game.mjs";
import { gameFrame, gameTime, paintGame, routePicture } from "./picture.mjs";
import { CLOCK_INIT, finger, Take } from "./take.mjs";
import {
  CHOICE,
  conversationList,
  DOT_RUN,
  DOT_RUN_DONE,
  routeNewTask,
  routePreviews,
  routeWorld,
  TASK,
} from "./world.mjs";

const draft = process.argv.includes("--draft");
const tall = process.argv.includes("--tall");
const asked = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const wanted = (name) => !asked.length || asked.includes(name);
const scale = draft ? 1 : 3;
const fps = draft ? 30 : 60;
const ASSETS = new URL("../assets/", import.meta.url).pathname;
const NOW = "2026-11-05T09:38:00.000Z";
const HEIGHT = tall ? 500 : 874;
const INSETS = tall ? { top: 0, bottom: 0 } : { top: 62, bottom: 34 };
const NOTES = `${ASSETS}capture/phone-touches${tall ? "-tall" : ""}.json`;
const RECTS = `${ASSETS}capture/phone-rects${tall ? "-tall" : ""}.json`;
const M = JSON.parse(readFileSync(new URL("../cues.json", import.meta.url), "utf8")).marks;

const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const notes = existsSync(NOTES) ? JSON.parse(readFileSync(NOTES, "utf8")) : {};
const rects = existsSync(RECTS) ? JSON.parse(readFileSync(RECTS, "utf8")) : {};
// Where an element is in the take at that moment, in the page's pixels.
const keep = (take, at, label, locator) =>
  take.at(at, async () => {
    const r = await locator().boundingBox();
    if (!r) throw new Error(`No box for ${label}`);
    rects[label] = { x: r.x, y: r.y, w: r.width, h: r.height };
    writeFileSync(RECTS, JSON.stringify(rects, null, 1));
  });
const H = { authorization: `Bearer ${TOKEN}` };

async function open({ env = {}, world, settings, height = HEIGHT, first = 0 }) {
  const fixture = await startFixture({ QA_SCENARIO: "running", QA_PAST: "1", QA_NOW: NOW, ...env });
  const context = await browser.newContext({
    viewport: { width: 402, height },
    deviceScaleFactor: scale,
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
    reducedMotion: "no-preference",
    locale: "en-GB",
    timezoneId: "UTC",
    serviceWorkers: "block",
    // For the one style the takes add: no caret.
    bypassCSP: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.addInitScript(() => {
    // Once, in the page itself: a screen's frame writing these again would reach the page as a change.
    if (window.top !== window || localStorage.getItem("localdot.view-style.v1")) return;
    localStorage.setItem("localdot.view-style.v1", "chat");
    localStorage.setItem("localdot.appearance.v1", "midnight");
    localStorage.setItem(
      "localdot.onboarding.v1",
      JSON.stringify({ step: "welcome", dismissed: true }),
    );
  });
  await page.addInitScript(CLOCK_INIT);
  await page.clock.install({ time: new Date(Date.parse(NOW) + 150_000) });
  if (world) await world(page);
  await routePicture(page, {
    dir: `${ASSETS}capture/frames`,
    screens: {
      "owned-preview.js": `/film-frames/dotrun/${String(first + 1).padStart(4, "0")}.jpg`,
    },
  });
  if (settings) {
    const saved = await (
      await page.request.get(`${fixture.origin}/api/agent/settings`, { headers: H })
    ).json();
    await page.request.put(`${fixture.origin}/api/agent/settings`, {
      headers: H,
      data: settings(saved),
    });
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: INSETS.top, right: 0, bottom: INSETS.bottom, left: 0 },
  });
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  await page.waitForFunction(() => !window.location.hash.includes("token="));
  // A text field's caret blinks on the browser's own clock, which the take doesn't step: none shows.
  await page.addStyleTag({ content: "* { caret-color: transparent !important; }" });
  await page.waitForTimeout(2500);
  return { page, cdp, fixture, hand: finger(cdp) };
}

const box = async (locator) => {
  await locator.waitFor({ timeout: 8000 });
  const r = await locator.boundingBox();
  if (!r) throw new Error(`No box for ${locator}`);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
};

// Waits until the task's dots on show, dot itself and the one on the line naming it, are each dressed in
// `look` and nothing else, holding the page's clock and its motion where they are.
async function wearing(page, look) {
  const want = [...look].sort().join(" ");
  for (let n = 0; ; n++) {
    const worn = await page.evaluate(async () => {
      await window.__filmStep(0);
      return [...document.querySelectorAll(".presence-frame .dot, .thread-dot .dot")].map((dot) =>
        dot.dataset.skin === "loading"
          ? "loading"
          : [...dot.querySelectorAll("img.dot-wear:not([data-leaving])")]
              .map((img) => img.dataset.wear)
              .sort()
              .join(" "),
      );
    });
    if (worn.length && worn.every((one) => one === want)) return;
    if (n > 300)
      throw new Error(`The task's dot wears ${worn.join(", ")}, not ${want || "nothing"}`);
  }
}

// A take of `name`, film seconds `from` to `to`, its finger's touches kept for the film to draw.
async function shoot(name, { page, hand }, from, to, direct) {
  const take = new Take(page, {
    out: `${ASSETS}capture/phone-${name}${tall ? "-tall" : ""}${draft ? "-draft" : ""}.mp4`,
    scale,
    fps,
    from,
    preset: draft ? "veryfast" : "medium",
  });
  await take.begin(new Date(Date.parse(NOW) + 160_000));
  const touches = [];
  const ONE_FRAME = 1 / fps;
  // A fingertip comes down over the beat before, and the tap lands on the beat. One held is pressed and
  // goes no further: the next screen is its own take.
  const tapAt = (at, target, label, { hold = false, shown = true } = {}) => {
    let b;
    take.at(at - 0.5, async () => {
      b = await box(target());
      if (shown) touches.push({ label, from: at - 0.5, up: at, x: b.x, y: b.y });
    });
    if (hold) take.at(at, () => hand.down(b.x, b.y));
    else {
      take.at(at - ONE_FRAME, () => hand.down(b.x, b.y));
      take.at(at, () => hand.up());
    }
  };
  await direct({ take, tapAt, keep: (at, label, locator) => keep(take, at, label, locator) });
  try {
    await take.until(to);
  } catch (error) {
    await page.screenshot({ path: `${ASSETS}capture/phone-failed.png` });
    throw error;
  }
  await take.end();
  notes[name] = touches;
  writeFileSync(NOTES, JSON.stringify(notes, null, 1));
}

const close = async ({ page, fixture }) => {
  await page.context().close();
  await fixture.close();
};

const row = (page) => page.locator(".phone-row").filter({ hasText: DOT_RUN.title });

// The frames of the computer's screen from film second `at`, as the app shows them, for the picture the
// film carries from one place on the phone to another.
function pictureClip(out, at) {
  execFileSync("nice", [
    "-n",
    "20",
    "ffmpeg",
    "-v",
    "error",
    "-y",
    "-framerate",
    "30",
    "-start_number",
    String(gameFrame(at) + 1),
    "-i",
    `${ASSETS}capture/frames/dotrun/%04d.jpg`,
    "-frames:v",
    "24",
    "-vf",
    "scale=1206:-2",
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-crf",
    "14",
    "-pix_fmt",
    "yuv420p",
    `${ASSETS}capture/${out}.mp4`,
  ]);
}

// A take's frame just before film second `at`, held a moment, with the picture's place in it cleared to
// the colour beside it: the picture has left.
function heldFrame(take, from, out, at, { x, y, w, h }, sample = [x - 10, y + h / 2]) {
  const when = (at - 1 / fps - from).toFixed(4);
  const pad = 6;
  const [r, g, b] = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    when,
    "-i",
    take,
    "-frames:v",
    "1",
    "-vf",
    `crop=2:2:${2 * Math.round(Math.max(0, sample[0] * scale) / 2)}:${2 * Math.round(Math.max(0, sample[1] * scale) / 2)}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  const colour = [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  const box = [x - pad, y - pad, w + 2 * pad, h + 2 * pad].map((v) => Math.round(v * scale));
  execFileSync("nice", [
    "-n",
    "20",
    "ffmpeg",
    "-v",
    "error",
    "-y",
    "-ss",
    when,
    "-i",
    take,
    "-vf",
    `trim=end_frame=1,drawbox=x=${box[0]}:y=${box[1]}:w=${box[2]}:h=${box[3]}:color=0x${colour}@1:t=fill,loop=loop=${Math.round(0.5 * fps) - 1}:size=1,setpts=N/(${fps}*TB)`,
    "-r",
    String(fps),
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-crf",
    "14",
    "-pix_fmt",
    "yuv420p",
    `${ASSETS}capture/${out}${tall ? "-tall" : ""}.mp4`,
  ]);
}

if (wanted("ask")) {
  let release;
  // The new task's one look, which the list gives it from its start: plain until Auto chooses its dot,
  // then Coder's hoodie, as the film's own dot wears it.
  let look = [];
  let fresh;
  let heard;
  const events = [];
  // Through the app's own events, as the daemon tells it of a conversation filed.
  const filed = (change) => {
    const event = { type: "conversation.organized", sessionId: fresh, tag: null, pinned: false };
    for (const ws of events) ws.send(JSON.stringify({ ...event, archived: false, ...change }));
  };
  const run = await open({
    env: { QA_SCENARIO: "ready" },
    // The computer's first picture is the run as it is when the task goes.
    first: gameFrame(M.send),
    world: async (page) => {
      release = await routeNewTask(page, { now: NOW });
      await routePreviews(page, NOW);
      await page.routeWebSocket(/\/api\/events$/, (ws) => {
        ws.connectToServer();
        events.push(ws);
      });
      // The list the phone opens on: every task a conversation, each with its own dot. The new task,
      // once there is one, under the words it was given until Auto names it.
      await page.route("**/api/conversations", async (route) => {
        const reply = await route.fetch().catch(() => undefined);
        if (!reply) return route.abort().catch(() => {});
        const body = await reply.json();
        await route.fulfill({
          json: conversationList(body, {
            now: NOW,
            hero: (entry) => ({ ...entry, title: null, look }),
            swap: { landlord: "invoice" },
          }),
        });
        if (body.conversations.some((entry) => entry.sessionId === fresh)) heard?.();
      });
      // The list hears of the task before the page does, so its dot is the plain one from its first
      // frame rather than a look the app would draw for it.
      await page.route(/\/api\/cells\/[0-9A-Z]+\/agent$/, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        const reply = await route.fetch();
        fresh = (await reply.json()).sessionId;
        await new Promise((resolve) => {
          heard = resolve;
          filed({});
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({ response: reply });
      });
    },
    settings: (saved) => ({ ...saved, persona: "everyday", autoPersona: true }),
  });
  const { page, fixture } = run;
  await page.request.post(`${fixture.origin}/__qa/reply?ms=600000`);
  await page.request.post(`${fixture.origin}/__qa/first-look`, {
    data: { title: DOT_RUN.title, persona: CHOICE.persona, reason: CHOICE.reason },
  });
  // One take from the conversation list to the computer the new task runs on: a new conversation, the
  // task sent, what Auto chose, dot's answer and first step, and the live picture tapped.
  const from = M.ask - 0.1;
  await shoot("ask", run, from, M.preview + 0.35, async ({ take, tapAt, keep }) => {
    take.onFrame = paintGame(page);
    tapAt(
      M.compose,
      () => page.getByRole("button", { name: /new conversation/i }).first(),
      "compose",
    );
    // Typed in, quickly, from the beat after the new conversation opens: the composer opens on its first
    // letter and grows a line as the words wrap, after its opening glide. Filled at once, the app's own
    // glide leaves the first line above the card's top edge for a third of a second (useComposerFold).
    const field = () => page.getByRole("textbox", { name: /^(New task|Message)$/ }).first();
    // The composer opens on the first letter; its own glide starts the field where the one-row pill had
    // it, over the toolbar it has just shown (useComposerFold's glide). With reduced motion it opens in
    // place, which is what these frames show.
    take.at(M.compose + 0.4, () => page.emulateMedia({ reducedMotion: "reduce" }));
    // And closes in place as the task goes, so no frame catches it half-folded.
    take.at(M.choice + 0.5, () => page.emulateMedia({ reducedMotion: "no-preference" }));
    for (let n = 1; n <= TASK.length; n++)
      take.at(M.compose + 0.5 + (n - 1) / 110, () => field().fill(TASK.slice(0, n)));
    tapAt(M.send, () => page.getByRole("button", { name: /^(Start task|Send)$/ }).first(), "send");
    take.at(M.send - 0.1, () => release.send());
    // Each lands on its beat's own frame: the thread draws what the stream says at its next tick, so
    // the page's clock runs on to that tick before the frame is taken.
    const until = async (shown) => {
      for (let ms = 0; ms < 400 && !(await shown().isVisible()); ms += 4)
        await page.clock.runFor(4);
    };
    // The task is taken up, and its computer's picture is in, before the frame is taken. The stage's
    // cover, up since the new conversation opened, goes once that picture is in, by the page's clock,
    // and goes at once, as it does when the picture is already on the stage.
    take.at(M.send, async () => {
      const cover = () =>
        page.evaluate(async () => {
          await window.__filmStep(0);
          if (!document.querySelector(".phone-thumb")) return "waiting";
          const shown = document.querySelector(".phone-thumb .switch-cover");
          return !shown ? "gone" : shown.closest("[data-leaving]") ? "leaving" : "up";
        });
      let state = await cover();
      for (let n = 0; state === "waiting"; n++) {
        if (n > 300) throw new Error("The new task never came up");
        state = await cover();
      }
      for (let ms = 0; state === "up"; ms += 4) {
        if (ms > 800) throw new Error("The computer's picture never came through");
        await page.clock.runFor(4);
        state = await cover();
      }
      await page.evaluate(() => {
        const leaving = document
          .querySelector(".phone-thumb .switch-cover")
          ?.closest("[data-leaving]");
        for (const a of leaving?.getAnimations({ subtree: true }) ?? [])
          if (a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY) a.finish();
      });
      for (let n = 0; state !== "gone"; n++) {
        if (n > 300) throw new Error("The stage's cover never went");
        state = await cover();
      }
      await wearing(page, []);
    });
    // Auto's choice: the task puts on Coder's hoodie as the line comes in, on the beat.
    take.at(M.choice, async () => {
      look = DOT_RUN.look;
      filed({ look });
      await wearing(page, look);
      release("persona.choice");
      await until(() => page.locator(".thread-dot").first());
      await wearing(page, look);
    });
    take.at(M.named, async () => {
      release("session.title");
      await until(() => page.getByText(DOT_RUN.title).first());
    });
    take.at(M.reply, async () => {
      release("message.assistant");
      await until(() => page.getByText(/^Love it\./).first());
    });
    take.at(M.caption, async () => {
      release("step.start");
      await until(() => page.getByText(/^Writing the game/).first());
    });
    // The line itself, its dot and its words, without the button beside it.
    keep(M.choice + 0.4, "choice", () => page.locator(".thread-dot").first());
    keep(M.choice + 0.4, "choiceWords", () => page.locator(".thread-dot-text").first());
    keep(M.watch, "thumb", () => page.locator(".phone-thumb").first());
    // The picture itself, in the thumbnail and once open, for the film to carry from one to the other.
    keep(M.watch, "thumbPicture", () => page.locator(".phone-thumb .phone-picture").first());
    keep(M.thumb + 0.6, "stagePicture", () => page.locator(".phone-picture").first());
    tapAt(M.thumb, () => page.locator(".phone-thumb").first(), "thumb");
    // What the computer shows by then, the run, is in the steps by the time the picture opens.
    take.at(M.thumb, () => release("step.start"));
    keep(M.thumb + 0.6, "stage", () => page.locator(".stage-frame").first());
  });
  await close(run);
  const take = `${ASSETS}capture/phone-ask${tall ? "-tall" : ""}.mp4`;
  pictureClip("phone-grow", M.thumb);
  heldFrame(take, from, "phone-hold", M.thumb, rects.thumb);
  pictureClip("phone-shrink", M.preview);
  // Below the picture and its glow, past the line under it: the screen's own colour.
  const { stagePicture: picture } = rects;
  heldFrame(take, from, "phone-hold-stage", M.preview, picture, [
    picture.x + picture.w - 10,
    picture.y + picture.h + 30,
  ]);
}

if (wanted("card")) {
  const run = await open({
    env: { QA_PHASE: "finished" },
    world: async (page) => {
      await routeWorld(page, { now: NOW, hero: DOT_RUN_DONE, finished: true });
      await routePreviews(page, NOW);
    },
  });
  const { page } = run;
  await row(page).first().tap();
  await page.waitForTimeout(1800);
  // The tap goes to the tab it opens as it does in the app's own previews spec.
  await page.evaluate(() => {
    window.open = () => ({
      opener: null,
      closed: false,
      location: { replace() {} },
      close() {},
    });
  });
  await shoot("card", run, M.preview - 0.1, M.open + 0.6, async ({ tapAt, keep }) => {
    keep(M.card - 0.5, "card", () => page.locator(".preview-card").first());
    tapAt(M.open, () => page.getByRole("button", { name: /^Open preview of/ }), "open");
  });
  await close(run);
}

// The game in the phone's own browser tab, the same run the computer shows, its clock the film's. The bar
// is real Safari's, from an iPhone 17 Pro simulator, on a dark page.
const BAR_HEIGHT = 170 / 3;

if (wanted("tab")) {
  const context = await browser.newContext({
    viewport: { width: 402, height: HEIGHT },
    deviceScaleFactor: scale,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.addInitScript(CLOCK_INIT);
  await page.clock.install({ time: new Date(NOW) });
  await serveGame(page);
  await page.goto("http://game.film/index.html");
  while (!(await page.evaluate(() => window.ready))) await new Promise((r) => setTimeout(r, 100));
  const bar = readFileSync(`${ASSETS}capture/safari-bar.png`).toString("base64");
  await page.evaluate(
    ({ bar, top, under, height }) => {
      document.body.style.setProperty("--top", `${top}px`);
      document.body.style.setProperty("--bottom", `${under + height}px`);
      const shown = document.createElement("img");
      shown.src = `data:image/png;base64,${bar}`;
      shown.style.cssText = `position:fixed;left:0;bottom:${under}px;width:402px;height:${height}px;mix-blend-mode:lighten`;
      document.body.append(shown);
      window.dispatchEvent(new Event("resize"));
    },
    // Where Safari has it: above the home indicator.
    { bar, top: INSETS.top, under: Math.max(4, INSETS.bottom - 4), height: BAR_HEIGHT },
  );
  const from = M.open - 0.1;
  const r = await page.locator("#play").boundingBox();
  rects.game = { x: r.x, y: r.y, w: r.width, h: r.height };
  writeFileSync(RECTS, JSON.stringify(rects, null, 1));
  const take = new Take(page, {
    out: `${ASSETS}capture/phone-tab${tall ? "-tall" : ""}${draft ? "-draft" : ""}.mp4`,
    scale,
    fps,
    from,
    preset: draft ? "veryfast" : "medium",
  });
  await take.begin(new Date(Date.parse(NOW) + 1000));
  // The phone's own tab has it at sunset.
  take.onFrame = (t) => page.evaluate((s) => window.render(s, "sunset"), gameTime(t));
  await take.until(M.desk + 0.6);
  await take.end();
  await context.close();
}

await browser.close();
console.log("done");
