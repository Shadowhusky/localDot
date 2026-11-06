// Every frame of each cut, checked for words over the app (each line of on-screen text against the phone,
// Studio and its windows, where those show) and for the app cut by the frame or its safe area. Run after building the stage, from apps/site:
//   node film-update/overlap-check.mjs [wide] [zh] [tall]
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const ROOT = new URL("./", import.meta.url).pathname;
const GSAP = new URL("../node_modules/gsap/dist/gsap.min.js", import.meta.url).pathname;
const FPS = 30;
const CUTS = {
  wide: { page: "index.html", size: { width: 1920, height: 1080 } },
  zh: { page: "index.html", size: { width: 1920, height: 1080 }, lang: "zh" },
  tall: { page: "vertical/index.html", size: { width: 1080, height: 1920 } },
};
const asked = process.argv.slice(2);
const { length, marks } = JSON.parse(readFileSync(`${ROOT}cues.json`, "utf8"));

function measure(t) {
  window.__timelines.main.seek(t, false);
  window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: t } }));
  const seen = (el) => {
    let alpha = 1;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (style.display === "none" || style.visibility === "hidden") return 0;
      alpha *= Number(style.opacity);
    }
    return alpha;
  };
  // Where the world shows when the camera is close: its mask's band, edges and all.
  const mask = document.getElementById("world").style.maskImage;
  const stops = [...mask.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
  const band = stops.length === 4 ? [stops[0], stops[3]] : [-Infinity, Infinity];
  const ui = [];
  for (const el of document.querySelectorAll("#chat, #room, .win")) {
    const id = el.id;
    if (seen(el) < 0.02) continue;
    const r = el.getBoundingClientRect();
    const top = Math.max(r.top, band[0]);
    const bottom = Math.min(r.bottom, band[1]);
    if (bottom > top) ui.push({ id, left: r.left, right: r.right, top, bottom });
  }
  const hits = [];
  // The device and the UI shown stay whole inside the frame's safe area with a margin, bezel and all:
  // the phone, Studio's window while it is the scene, and every window once the grid is all there.
  // How far the worst edge is over goes on the record of every frame.
  const { W, H, tall } = window.__frame;
  const t0 = window.__marks;
  const MARGIN = 20;
  const over = (r) =>
    Math.max(
      MARGIN - r.left,
      r.right - (W - MARGIN),
      (tall ? 200 : MARGIN) - r.top,
      r.bottom - (tall ? 1500 : H - MARGIN),
      tall && r.bottom > 900 ? r.right - (W - 170) : Number.NEGATIVE_INFINITY,
    );
  const worst = { by: Number.NEGATIVE_INFINITY, what: "" };
  const whole = (el, when, bezel = 0) => {
    if (!when || seen(el) < 0.5) return;
    const box = el.getBoundingClientRect();
    const k = box.width / el.offsetWidth;
    const r = {
      left: box.left - bezel * k,
      right: box.right + bezel * k,
      top: box.top - bezel * k,
      bottom: box.bottom + bezel * k,
    };
    const by = over(r);
    if (by > worst.by) Object.assign(worst, { by, what: el.id });
    if (by > 0) hits.push({ text: "frame", ui: el.id, area: Math.round(by) });
  };
  // The pan from the phone to the desk carries it out of the frame on purpose.
  const panning = t >= t0.desk && t < t0.desk + 0.5;
  whole(document.getElementById("chat"), !panning, 14);
  whole(document.getElementById("room"), t >= t0.desk + 0.5 && t < t0.several);
  for (const win of document.querySelectorAll(".win")) whole(win, t >= t0.w9 + 0.5 && t < t0.away);
  window.__worst = worst;
  for (const el of document.querySelectorAll(".words, #end-name, #end-url, #end-line")) {
    if (seen(el) < 0.02) continue;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || seen(node.parentElement) < 0.02) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) {
        for (const box of ui) {
          const w = Math.min(line.right, box.right) - Math.max(line.left, box.left);
          const h = Math.min(line.bottom, box.bottom) - Math.max(line.top, box.top);
          if (w > 0 && h > 0) hits.push({ text: el.id, ui: box.id, area: Math.round(w * h) });
        }
      }
    }
  }
  return hits;
}

const browser = await chromium.launch();
let total = 0;
for (const [name, cut] of Object.entries(CUTS)) {
  if (asked.length && !asked.includes(name)) continue;
  const page = await browser.newPage({ viewport: cut.size });
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.fulfill({ path: GSAP }));
  await page.route("http://film.test/**", (route) =>
    route.fulfill({ path: `${ROOT}${new URL(route.request().url()).pathname.slice(1)}` }),
  );
  // What the HyperFrames runtime would give the page: somewhere for its timeline, and the cut's language.
  await page.addInitScript(
    ([lang, size, marks]) => {
      window.__frame = { W: size.width, H: size.height, tall: size.height > size.width };
      window.__marks = marks;
      window.__timelines = {};
      if (lang) window.__hyperframes = { getVariables: () => ({ lang }) };
    },
    [cut.lang ?? "", cut.size, marks],
  );
  await page.goto(`http://film.test/${cut.page}`);
  await page.waitForFunction(() => Boolean(window.__timelines?.main), null, {
    polling: 250,
    timeout: 120_000,
  });
  await page.evaluate(() => document.fonts.ready);
  const spans = new Map();
  let worst = { by: Number.NEGATIVE_INFINITY, what: "", t: 0 };
  for (let f = 0; f <= length * FPS; f++) {
    const t = f / FPS;
    const hits = await page.evaluate(measure, t);
    const frame = await page.evaluate(() => window.__worst);
    if (frame.by > worst.by) worst = { ...frame, t };
    for (const hit of hits) {
      const key = `${hit.text} over ${hit.ui}`;
      const span = spans.get(key) ?? { from: t, to: t, area: 0 };
      span.to = t;
      span.area = Math.max(span.area, hit.area);
      spans.set(key, span);
    }
  }
  console.log(`${name}: ${spans.size ? "" : "no text over the app, nothing cut by the frame"}`);
  console.log(
    `  closest to the frame's safe edge: #${worst.what} at ${worst.t.toFixed(2)} s, ${(-worst.by).toFixed(0)} px inside`,
  );
  for (const [key, s] of spans)
    console.log(
      `  ${key}: ${s.from.toFixed(2)}-${s.to.toFixed(2)} s, up to ${s.area} ${key.startsWith("frame") ? "px over" : "px²"}`,
    );
  total += spans.size;
  await page.close();
}
await browser.close();
process.exitCode = total ? 1 : 0;
