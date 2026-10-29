import { composer, expect, runAt, test } from "./harness.ts";
import {
  between,
  countRequests,
  eventLatency,
  grew,
  installProbes,
  mark,
  record,
  streamDesktop,
} from "./perf.ts";

// What watching a running task costs the page: 30 s of a busy live run (/__qa/live-run) with its
// screen streaming at the rate the viewer asks for (streamDesktop), then 40 characters typed while it
// goes on, at 1440 and on a phone whose CPU is slowed four times. It reports numbers; the bounds
// only catch a broken measurement or a page that stopped answering.
// Typing figures are [all, less the run's own]. QA_PERF_OUT=<file> appends each run as a JSON line.
runAt("c14", "c39");
test.use({
  fixedClock: false,
  // Motion as most people see it: the harness reduces it.
  reducedMotion: "no-preference",
  // A laptop's display: the stage's canvas and the page are drawn at twice their CSS size.
  deviceScaleFactor: 2,
  // The GPU draws, as in a browser on the Mac, rather than the software rasterizer.
  launchOptions: async ({ browserName }, use) =>
    use(browserName === "chromium" ? { args: ["--enable-gpu"] } : {}),
});

const WATCH_MS = 30_000;
const TYPED = "check the totals and add a monthly chart";
const SESSION_READ = /^\/api\/agent\/sessions\/[0-9A-HJKMNP-TV-Z]{26}$/;

test("a live run's cost to the page", async ({ page, ui }) => {
  test.setTimeout(180_000);
  const phone = test.info().project.name === "c39";
  await installProbes(page);
  await streamDesktop(page);
  const sessionReads = countRequests(page, SESSION_READ);
  const fixture = await ui.open("running");
  const box = (await composer(page)).getByRole("textbox", { name: "Message" });
  await expect(box).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  if (phone) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const run = await page.request.post(`${fixture.origin}/__qa/live-run?ms=${WATCH_MS + 60_000}`);
  expect(run.ok()).toBe(true);
  await page.waitForTimeout(3_000);

  const start = await mark(page, cdp);
  await page.waitForTimeout(WATCH_MS);
  const watched = await mark(page, cdp);
  const reads = sessionReads().filter((at) => at >= start.at && at < watched.at).length;
  const watch = {
    ...between(start, watched),
    sessionReadsPerMin: Math.round((reads * 60_000) / (watched.at - start.at)),
  };

  await box.focus();
  const before = await mark(page, cdp);
  const from = await page.evaluate(() => performance.now());
  await box.pressSequentially(TYPED, { delay: 120 });
  await expect(box).toHaveValue(TYPED);
  const to = await page.evaluate(() => performance.now());
  const after = await mark(page, cdp);
  await cdp.detach();
  const keys = TYPED.length;
  // Per key, and per key less what the run alone caused in as long while watching.
  const share = (after.at - before.at) / (watched.at - start.at);
  const perKey = (name: string, scale = 1) => {
    const total = grew(before, after, name) * scale;
    const net = total - grew(start, watched, name) * scale * share;
    return [Math.round((total / keys) * 10) / 10, Math.round((net / keys) * 10) / 10];
  };
  const commits = after.counts.commits - before.counts.commits;
  const typing = {
    seconds: Math.round((after.at - before.at) / 100) / 10,
    recalcsPerKey: perKey("RecalcStyleCount"),
    layoutsPerKey: perKey("LayoutCount"),
    mainTaskMsPerKey: perKey("TaskDuration", 1000),
    mainCpuMsPerKey: perKey("ThreadTime", 1000),
    commitsPerKey: [
      Math.round((commits / keys) * 10) / 10,
      Math.round(
        ((commits - (watched.counts.commits - start.counts.commits) * share) / keys) * 10,
      ) / 10,
    ],
    keydown: eventLatency(after.counts, "keydown", { from, to }, keys),
    input: eventLatency(after.counts, "input", { from, to }, keys),
  };

  await expect(page.locator(".thread-scroll")).toContainText("matches the receipts");
  const result = { spec: "live-run", project: test.info().project.name, watch, typing };
  console.log(JSON.stringify(result));
  test.info().annotations.push({ type: "live run", description: JSON.stringify(result) });
  record(result);
  expect(watch.commitsPerS).toBeGreaterThan(0);
  expect(watch.commitsPerS).toBeLessThan(120);
  expect(watch.rafFps).toBeGreaterThan(phone ? 2 : 10);
  expect(watch.longTaskMs).toBeLessThan(WATCH_MS * 0.8);
  expect(watch.sessionReadsPerMin).toBeLessThan(3_000);
  expect(typing.keydown.p75Ms).toBeLessThan(1_000);
  // Budgets, generous over what the app does now; QA_UI_DIR measures another build against them.
  if (process.env.QA_UI_DIR) return;
  expect(watch.theatreRendersPerS, "page redraws a second").toBeLessThanOrEqual(phone ? 5 : 8);
  expect(watch.componentsPerCommit, "components drawn a commit").toBeLessThanOrEqual(40);
  expect(watch.sessionReadsPerMin, "status reads a minute").toBeLessThanOrEqual(150);
  expect(typing.recalcsPerKey[1], "style recalcs a key, less the run's").toBeLessThan(4);
  expect(typing.layoutsPerKey[1], "layouts a key, less the run's").toBeLessThan(4);
});
