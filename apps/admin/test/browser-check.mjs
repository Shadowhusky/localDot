import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, webkit } from "@playwright/test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const TOKEN = "local-browser-test-token-0123456789abcdef";
const output = "/tmp/localdot-stats-ui";
mkdirSync(output, { recursive: true });
const mf = new Miniflare(
  convertV4MiniflareOptions({
    host: "127.0.0.1",
    port: 8897,
    https: true,
    workers: [
      {
        name: "admin",
        modules: true,
        scriptPath: "dist/worker.js",
        compatibilityDate: "2026-11-04",
        bindings: { OWNER_TOKEN: TOKEN },
        d1Databases: { DB: "stats", REPORTS: "reports" },
      },
    ],
  }),
);
const url = await mf.ready;
const db = await mf.getD1Database("DB");
await db.exec(
  readFileSync("migrations/0001_stats.sql", "utf8")
    .replace(/--[^\n]*/g, "")
    .replace(/\n/g, " "),
);
const now = Date.now(),
  day = 86_400_000,
  start = Math.floor(now / day) * day - 29 * day;
const ops = [];
for (let i = 0; i < 30; i++) {
  const at = start + i * day,
    n = 45 + i * 7 + (i % 4) * 15;
  for (const [event, count] of [
    ["page", n],
    ["installer_shell", Math.round(n * 0.17)],
    ["installer_windows", Math.round(n * 0.09)],
  ])
    ops.push(db.prepare("INSERT INTO counters VALUES(?,?,'total','all',?)").bind(at, event, count));
}
for (const [dim, labels] of [
  ["country", ["GB", "US", "CN", "DE", "JP", "CA", "FR", "KR"]],
  ["source", ["direct", "github", "google", "youtube", "localdot", "reddit", "other"]],
  ["platform", ["macOS", "Windows", "iOS", "Android", "Linux"]],
])
  for (let i = 0; i < labels.length; i++)
    ops.push(
      db
        .prepare("INSERT INTO counters VALUES(?,'page',?,?,?)")
        .bind(start, dim, labels[i], 600 - i * 60),
    );
for (const [k, v] of [
  ["tracking_since", start - 40 * day],
  ["github_checked", now],
  ["downloads_since", start],
])
  ops.push(db.prepare("INSERT INTO meta VALUES(?,?)").bind(k, String(v)));
for (let i = 0; i < 35; i++)
  ops.push(
    db
      .prepare("INSERT INTO assets VALUES(?,?,?,?,?,?,?)")
      .bind(
        i + 1,
        `v0.1.0-rc.${39 - Math.floor(i / 2)}`,
        i % 2 ? "linux-x64" : "darwin-arm64",
        `fixture-${i}`,
        900 - i * 24,
        new Date(now - i * day).toISOString(),
        now,
      ),
  );
await db.batch(ops);
const reports = await mf.getD1Database("REPORTS");
await reports.exec(
  "CREATE TABLE reports(received_at INTEGER,install_id TEXT,status TEXT,version TEXT)",
);
await reports
  .prepare("INSERT INTO reports VALUES(?,?,?,?)")
  .bind(now, "fixture-install", "new", "0.1.0-rc.39")
  .run();
const evidence = [];
try {
  for (const [engine, name, width, height] of [
    [chromium, "desktop", 1440, 1000],
    [chromium, "phone", 390, 844],
    [webkit, "webkit-phone", 320, 740],
  ]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width, height },
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(new URL("/stats", url).href);
      await page.getByLabel("Owner key").fill(TOKEN);
      await page.getByRole("button", { name: "Open dashboard" }).click();
      await page.screenshot({ path: `${output}/${name}-after-login.png`, fullPage: true });
      console.log(name, page.url(), (await page.locator("body").innerText()).slice(0, 240));
      await page.getByRole("heading", { name: "A little perspective." }).waitFor({ timeout: 5000 });
      for (const tab of ["Overview", "Downloads", "Audience", "App health"]) {
        await page.getByRole("link", { name: tab, exact: true }).click();
        await page.locator(".cards,.health-summary").first().waitFor();
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          `${name} ${tab} overflow`,
        );
        await page.screenshot({
          path: `${output}/${name}-${tab.toLowerCase().replaceAll(" ", "-")}.png`,
          fullPage: true,
        });
      }
      await page.getByRole("link", { name: "7d", exact: true }).click();
      assert.ok(page.url().includes("period=7d"));
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.getByLabel("Owner key").waitFor();
      assert.equal(errors.length, 0, errors.join("\n"));
      evidence.push({
        browser: name,
        width,
        login: true,
        tabs: 4,
        range: true,
        logout: true,
        noOverflow: true,
        noPageErrors: true,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
  writeFileSync(`${output}/checks.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await mf.dispose();
}
