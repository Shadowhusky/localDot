import { chromium } from "@playwright/test";

const [url, out, width = "1440", height = "900", settleMs = "1000"] = process.argv.slice(2);
if (!url || !out) {
  console.error(
    "usage: pnpm --filter @localdot/web shot <url> <out.png> [width] [height] [settleMs]",
  );
  process.exit(2);
}
// A fresh profile every run: it holds no install token, so the URL must carry #token=.
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({
  viewport: { width: Number(width), height: Number(height) },
  deviceScaleFactor: 2,
});
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(Number(settleMs));
await page.screenshot({ path: out });
console.log(`wrote ${out}; final url ${page.url()}`);
await browser.close();
