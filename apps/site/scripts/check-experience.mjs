// The site's acceptance check, against a running dev or preview server:
//   SITE_URL=http://127.0.0.1:4321 node scripts/check-experience.mjs
// Chromium and WebKit at desktop, tablet and phone sizes: the app opens still and plays a demo when
// one is picked, every chapter shows its words inside the screen without the page overflowing, and
// nothing logs an error. Also reduced motion, no JavaScript, places in the address, and the page
// in Chinese. Screenshots
// and results go to ignored qa/check/.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "@playwright/test";

const origin = process.env.SITE_URL || "http://127.0.0.1:4321";
const out = new URL("../qa/check/", import.meta.url);
await mkdir(out, { recursive: true });

const ALL_SIZES = [
  [1920, 1080, false],
  [1440, 900, false],
  [1280, 800, false],
  [1024, 768, false],
  [768, 1024, true],
  [390, 844, true],
  [375, 667, true],
  [844, 390, true],
];
// SIZES=375x667,844x390 checks only those; ENGINES=webkit only that browser.
const SIZES = process.env.SIZES
  ? ALL_SIZES.filter(([w, h]) => process.env.SIZES.split(",").includes(`${w}x${h}`))
  : ALL_SIZES;
// A chapter, and how far into it to look.
const MOMENTS = [
  ["out", 0.95],
  ["watch", 0.25],
  ["watch", 0.55],
  ["watch", 0.85],
  ["models", 0.5],
  ["replay", 0.3],
  ["replay", 0.8],
  ["dots", 0.08],
  ["dots", 0.32],
  ["dots", 0.9],
  ["yours", 0.5],
  ["install", 0.6],
];

// Scrolls to a moment in a chapter and reports what shows: whether the page overflows sideways,
// how many of the chapter's words show, and whether they sit inside the screen.
function look(page, chapter, at) {
  return page.evaluate(
    async ([name, share]) => {
      const mark = document.querySelector(`.mark[data-chapter="${name}"]`);
      const from = Number(mark.dataset.from);
      const to = Number(mark.dataset.to);
      scrollTo(
        0,
        document.getElementById("story").offsetTop + (from + share * (to - from)) * innerHeight,
      );
      await new Promise((resolve) => setTimeout(resolve, 1300));
      const shown = () =>
        [
          ...document.querySelectorAll(
            `[data-chapter="${name}"] .beat, [data-chapter="${name}"] .role`,
          ),
        ].filter((el) => Number(getComputedStyle(el).opacity) > 0.6);
      // Software-rendered browsers draw a few frames a second, so the scene can take longer
      // to catch up with the scroll.
      for (let waited = 0; waited < 8000 && shown().length === 0; waited += 250)
        await new Promise((resolve) => setTimeout(resolve, 250));
      const visible = shown();
      const boxes = visible.map((el) => el.getBoundingClientRect());
      const bar = document.querySelector(".site-nav");
      const top =
        bar && getComputedStyle(bar).display !== "none" ? bar.getBoundingClientRect().bottom : 0;
      return {
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        words: visible.length,
        // Inside the screen, and not under the site's bar once it shows.
        inside: boxes.every(
          (b) =>
            b.left >= -1 &&
            b.right <= innerWidth + 1 &&
            b.bottom <= innerHeight + 1 &&
            b.top >= top - 1,
        ),
      };
    },
    [chapter, at],
  );
}

const results = [];
for (const [engine, launcher] of [
  ["chromium", chromium],
  ["webkit", webkit],
].filter(([name]) => !process.env.ENGINES || process.env.ENGINES.split(",").includes(name))) {
  const browser = await launcher.launch();
  try {
    for (const [width, height, touch] of SIZES) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
        hasTouch: touch,
        isMobile: touch && engine === "chromium",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await page.goto(origin, { waitUntil: "networkidle" });
      // The page opens still, on the app's task picker, and stays so until a task is picked.
      await page.waitForTimeout(2500);
      const still = await page.evaluate(() => ({
        playing: !(document.querySelector(".site-video")?.paused ?? true),
        tasks: document.querySelectorAll(".site-app .site-demo").length,
      }));
      assert.equal(still.playing, false, `${engine} ${width}x${height}: a demo played by itself`);
      assert.ok(still.tasks > 0, `${engine} ${width}x${height}: no task picker on the landing`);
      // Picking the first task plays its recording.
      await page.locator(".site-app .site-demo").first().click();
      await page.waitForFunction(
        () => (document.querySelector(".site-video")?.currentTime ?? 0) > 0.5,
        null,
        { timeout: 45000 },
      );
      await page.screenshot({
        path: new URL(`${engine}-${width}x${height}-app.png`, out).pathname,
      });
      // Beside the stage, the chat rail follows it with no empty column between them: the stage may
      // sit centred in its column, but an empty Activity column would leave over 300 px.
      const gap = await page.evaluate(() => {
        const stage = document.querySelector(".site-app .stage-frame")?.getBoundingClientRect();
        const rail = document.querySelector(".site-app .rail-chat")?.getBoundingClientRect();
        return stage && rail && rail.left >= stage.right ? rail.left - stage.right : 0;
      });
      assert.ok(
        gap < 200,
        `${engine} ${width}x${height}: ${Math.round(gap)} px between the stage and the chat`,
      );
      for (const [chapter, at] of MOMENTS) {
        const seen = await look(page, chapter, at);
        await page.screenshot({
          path: new URL(`${engine}-${width}x${height}-${chapter}-${at}.png`, out).pathname,
          timeout: 60000,
        });
        results.push({ engine, width, height, chapter, at, ...seen });
        const where = `${engine} ${width}x${height} ${chapter} ${at}`;
        assert.equal(seen.overflow, false, `${where}: the page overflows sideways`);
        assert.ok(seen.words > 0, `${where}: no words show`);
        assert.ok(seen.inside, `${where}: words run off the screen`);
      }
      assert.deepEqual(errors, [], `${engine} ${width}x${height} logged errors`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

// Reduced motion: nothing plays by itself, and the story still reads.
{
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  const playing = await page.evaluate(() => {
    const video = document.querySelector(".site-video");
    return !!video && !video.paused;
  });
  assert.equal(playing, false, "reduced motion still plays a demo by itself");
  await page.screenshot({ path: new URL("reduced.png", out).pathname });
  await browser.close();
}

// axe finds no WCAG 2.2 A/AA violations in the app or at the install command, on a desktop and a
// phone.
{
  const axe = await readFile(
    new URL("../node_modules/axe-core/axe.min.js", import.meta.url),
    "utf8",
  );
  const browser = await chromium.launch();
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForTimeout(3000);
    await page.addScriptTag({ content: axe });
    for (const at of ["app", "install"]) {
      if (at === "install")
        await page.evaluate(async () => {
          const mark = document.querySelector('.mark[data-chapter="install"]');
          const share =
            Number(mark.dataset.from) + 0.6 * (Number(mark.dataset.to) - Number(mark.dataset.from));
          scrollTo(0, document.getElementById("story").offsetTop + share * innerHeight);
          await new Promise((resolve) => setTimeout(resolve, 2500));
        });
      const violations = await page.evaluate(async () => {
        const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
        const result = await window.axe.run(document, { runOnly: { type: "tag", values: tags } });
        return result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        );
      });
      assert.deepEqual(violations, [], `axe at ${width}x${height} ${at}`);
    }
    await page.close();
  }
  await browser.close();
}

// Without JavaScript the story is a page of sections with the install command in it.
{
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    javaScriptEnabled: false,
  });
  await page.goto(origin, { waitUntil: "load" });
  const text = await page.locator("body").innerText();
  for (const words of [
    "Hi, I'm dot.",
    "Use any model.",
    "A dot for every job.",
    "Get localDot.",
    "install.sh",
  ])
    assert.ok(text.includes(words), `without JavaScript the page lacks "${words}"`);
  await page.screenshot({ path: new URL("no-js.png", out).pathname, fullPage: true });
  await browser.close();
}

// Under the built site's own Content-Security-Policy, from its _headers, nothing is refused: the
// first inline script runs, the outfits' textures load, and a finished task's result card shows its
// moments, opens its file and downloads it. Only against a production build; the dev server's own scripts are not in the policy.
{
  const page0 = await (await fetch(origin)).text();
  if (page0.includes("/@vite/client"))
    console.log("Content-Security-Policy: skipped on a dev server.");
  else {
    const headers = await readFile(new URL("../dist/_headers", import.meta.url), "utf8");
    const csp = headers.match(/Content-Security-Policy: (.*)/)?.[1] ?? "";
    assert.ok(csp, "dist/_headers has no Content-Security-Policy");
    for (const [engine, launcher] of [
      ["chromium", chromium],
      ["webkit", webkit],
    ]) {
      const browser = await launcher.launch();
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        acceptDownloads: true,
      });
      await context.route("**/*", async (route) => {
        if (route.request().resourceType() !== "document") return route.continue();
        const response = await route.fetch();
        await route.fulfill({
          response,
          headers: { ...response.headers(), "content-security-policy": csp },
        });
      });
      await context.addInitScript(() => {
        window.__refused = [];
        document.addEventListener("securitypolicyviolation", (e) =>
          window.__refused.push(`${e.violatedDirective} ${e.blockedURI}`),
        );
      });
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "load" });
      await page.waitForTimeout(2500);
      const ran = await page.evaluate(() => document.documentElement.classList.contains("js"));
      assert.ok(ran, `${engine}: the first inline script did not run under the policy`);
      await page.locator(".site-app .site-demo").nth(3).click();
      await page.waitForFunction(
        () => (document.querySelector(".site-video")?.currentTime ?? 0) > 0.3,
        null,
        { timeout: 45000 },
      );
      await page.evaluate(() => {
        const video = document.querySelector(".site-video");
        video.currentTime = video.duration - 0.2;
      });
      await page.waitForFunction(
        () => document.querySelector(".site-app")?.dataset.phase === "done",
        null,
        { timeout: 30000 },
      );
      await page.waitForTimeout(3000);
      // The task's result opens in the viewer and downloads as the file itself.
      await page
        .locator(".site-app button", { hasText: /^Open$/ })
        .first()
        .click();
      await page.waitForFunction(
        () => (document.querySelector(".file-viewer canvas")?.width ?? 0) > 0,
        null,
        { timeout: 15000 },
      );
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 15000 }),
        page.locator('.site-app button[aria-label^="Download"]').first().click(),
      ]);
      assert.equal(download.suggestedFilename(), "blue-hour-a3.pdf", `${engine}: wrong download`);
      await page.evaluate(() => {
        location.hash = "#coder";
      });
      await page.waitForTimeout(5000);
      const refused = await page.evaluate(() => [...new Set(window.__refused)]);
      assert.deepEqual(refused, [], `${engine}: the policy refused something`);
      await browser.close();
    }
  }
}

// The address names the place the story is at: opened there, the story lands on that beat at once,
// without playing down to it; scrolling names each place in turn; a reload holds the place.
{
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.__seen = new Set();
    const t0 = performance.now();
    const look = () => {
      for (const el of document.querySelectorAll(".beat[data-place]"))
        if (Number(el.style.opacity || 0) > 0.05) window.__seen.add(el.dataset.place);
      if (performance.now() - t0 < 2500) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/#step-in`, { waitUntil: "load" });
  await page.waitForTimeout(2600);
  const opened = await page.evaluate(() => ({
    seen: [...window.__seen],
    hash: location.hash,
    shown: Number(document.querySelector('.beat[data-place="step-in"]')?.style.opacity ?? 0),
  }));
  assert.deepEqual(opened.seen, ["step-in"], "opening at a place played other beats on the way");
  assert.equal(opened.hash, "#step-in");
  assert.ok(opened.shown > 0.9, "the place's words do not show");
  const named = [];
  for (let i = 0; i <= 40; i++) {
    await page.evaluate(
      (i) => scrollTo(0, (i / 40) * (document.documentElement.scrollHeight - innerHeight)),
      i,
    );
    // The page names the place on its next scroll event; two frames on, it has had one.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    const hash = await page.evaluate(() => location.hash);
    if (named.at(-1) !== hash) named.push(hash);
  }
  for (const place of [
    "#hello",
    "#watch",
    "#step-in",
    "#models",
    "#share",
    "#dots",
    "#pick",
    "#get",
  ])
    assert.ok(named.includes(place), `scrolling never named ${place}`);
  await page.goto(`${origin}/#finance`, { waitUntil: "load" });
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2600);
  const role = await page.evaluate(
    () =>
      [...document.querySelectorAll(".role")].find((r) => Number(r.style.opacity) > 0.6)?.dataset
        .persona,
  );
  assert.equal(role, "finance", "a reload did not hold the place");
  assert.deepEqual(errors, [], "places logged errors");
  await browser.close();
}

// A visitor whose system reads Chinese gets the page in Chinese, with no English showing before
// it arrives; every chapter's words fit; axe passes; the film is the Chinese cut; and the toggle
// brings English back and remembers it.
{
  const axe = await readFile(
    new URL("../node_modules/axe-core/axe.min.js", import.meta.url),
    "utf8",
  );
  const browser = await chromium.launch();
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    const where = `Chinese ${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
    await context.addInitScript(() => {
      window.__english = [];
      const watch = () => {
        if (document.documentElement.hasAttribute("data-i18n-done")) return;
        for (const el of document.querySelectorAll(
          "[data-i18n], [data-i18n-html], [data-i18n-list]",
        ))
          if (getComputedStyle(el).visibility === "visible" && /[a-z]{3}/.test(el.textContent))
            window.__english.push(el.textContent.trim().slice(0, 40));
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const opened = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      english: window.__english,
      film: document.querySelector("[data-film]")?.getAttribute("href"),
      greeting: document.querySelector(".site-start")?.textContent ?? "",
    }));
    assert.equal(opened.lang, "zh-Hans", `${where}: the page is not in Chinese`);
    assert.match(opened.title, /[\u4e00-\u9fff]/, `${where}: the title is not in Chinese`);
    assert.deepEqual(opened.english, [], `${where}: English showed before the Chinese`);
    assert.equal(opened.film, "/film/localdot-film-zh.mp4", `${where}: not the Chinese film`);
    assert.match(opened.greeting, /[\u4e00-\u9fff]/, `${where}: the app greets in English`);
    for (const [chapter, at] of MOMENTS) {
      const seen = await look(page, chapter, at);
      await page.screenshot({
        path: new URL(`zh-${width}x${height}-${chapter}-${at}.png`, out).pathname,
        timeout: 60000,
      });
      results.push({ engine: "chromium", lang: "zh", width, height, chapter, at, ...seen });
      assert.equal(seen.overflow, false, `${where} ${chapter} ${at}: the page overflows sideways`);
      assert.ok(seen.words > 0, `${where} ${chapter} ${at}: no words show`);
      assert.ok(seen.inside, `${where} ${chapter} ${at}: words run off the screen`);
    }
    await page.addScriptTag({ content: axe });
    const violations = await page.evaluate(async () => {
      const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
      const result = await window.axe.run(document, { runOnly: { type: "tag", values: tags } });
      return result.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      );
    });
    assert.deepEqual(violations, [], `axe in ${where}`);
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(800);
    await Promise.all([page.waitForEvent("load"), page.locator('[data-act="lang"]').click()]);
    await page.waitForTimeout(1500);
    const switched = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      kept: localStorage.getItem("localdot.lang"),
      toggle: [...(document.querySelector('[data-act="lang"]')?.children ?? [])].find(
        (label) => getComputedStyle(label).display !== "none",
      )?.textContent,
    }));
    assert.equal(switched.lang, "en", `${where}: the toggle did not switch to English`);
    assert.equal(switched.kept, "en", `${where}: the choice of English was not kept`);
    assert.equal(switched.toggle, "中文", `${where}: the toggle does not offer Chinese back`);
    assert.deepEqual(errors, [], `${where} logged errors`);
    await context.close();
  }
  await browser.close();
}

await writeFile(new URL("results.json", out), JSON.stringify(results, null, 2));
console.log(
  `${results.length} chapter views checked; reduced motion, accessibility, no JavaScript, the CSP, places and Chinese checked.`,
);
