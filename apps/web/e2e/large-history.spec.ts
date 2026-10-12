import { writeFileSync } from "node:fs";
import { ulid } from "@localdot/protocol";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { fixture, load, proof } from "./fixtures/recovery-server.ts";
import { showActivity, showChat } from "./layout.ts";
import { settingsSheet } from "./settings-ui.ts";

test.setTimeout(60_000);

async function attachEvidence(
  info: TestInfo,
  name: string,
  value: { body: string; contentType: string },
) {
  const path = info.outputPath(name);
  writeFileSync(path, value.body);
  await info.attach(name, { path, contentType: value.contentType });
}

async function seed(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  let outputStep = "";
  for (let n = 1; n <= count / 2; n++) {
    f.session.append("message.user", {
      messageId: ulid(),
      kind: "steer",
      text: `Recorded message ${n}`,
    });
    const step = ulid();
    f.session.append("step.start", { kind: "shell" }, step);
    f.session.append("tool.start", { tool: "shell", title: `Replay command ${n}` }, step);
    if (n === count / 2) {
      outputStep = step;
      for (let chunk = 0; chunk < 8; chunk++)
        f.session.append(
          "tool.output",
          {
            stream: "stdout",
            chunk: `Output block ${chunk}\n${"Long recorded line\n".repeat(700)}`,
          },
          step,
        );
    }
    f.session.append("tool.end", { ok: true, exitCode: 0 }, step);
    f.session.append("step.end", { status: "ok", note: `Recorded step ${n}` }, step);
  }
  f.session.append("ask.request", {
    askId: ulid(),
    question: "Keep the recorded report?",
    options: [{ key: "A", text: "Keep it" }],
    allowText: true,
  });
  f.session.append("task.result", { summary: "Replay retained result marker", files: [] });
  return { outputStep, mixedRows: count, eventCount: f.log.read(f.id).length };
}
async function counts(page: Page) {
  return page.evaluate(() => ({
    messages: document.querySelectorAll(".thread-row").length,
    steps: document.querySelectorAll("[data-testid='tool-row'], [data-testid='step-row']").length,
    outputViewers: document.querySelectorAll(".terminal-viewer").length,
  }));
}

// Dedicated fixed Chrome fixture: timing is not part of the ordinary host suite.
test("10,000 mixed rows stay bounded through replay, explicit history reading and responsive Stop", async ({
  browser,
}, info) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const f = await fixture("api", "paused", false, true);
  try {
    const history = await seed(f, 10_000);
    await page.addInitScript(() => {
      const timing = { clickAt: 0, dispatchMs: -1 };
      Object.defineProperty(window, "stopTiming", { value: timing });
      document.addEventListener(
        "click",
        (event) => {
          if ((event.target as Element | null)?.closest("[data-testid=hud-stop-session]"))
            timing.clickAt = performance.now();
        },
        true,
      );
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (
          init?.method === "POST" &&
          /\/api\/agent\/sessions\/[^/]+\/stop$/.test(url) &&
          timing.clickAt
        )
          timing.dispatchMs = performance.now() - timing.clickAt;
        return originalFetch(input, init);
      };
    });
    const p = await load(page, f);
    await expect(page.locator("article.thread-message").last()).toContainText(
      "Recorded message 5000",
    );
    expect(
      await page.locator(".thread-scroll").evaluate((element) => element.clientHeight),
    ).toBeGreaterThanOrEqual(160);
    await expect(page.getByText("Replay retained result marker", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Keep the recorded report?", { exact: true }).first(),
    ).toBeVisible();
    // Activity is the rail's other view at this width; the thread stays mounted under it.
    await showActivity(page);
    await expect(page.getByTestId("tool-row").last()).toContainText("Replay command 5000");
    const initial = await counts(page);
    // The thread opens on its newest 40 rows (OPENING_ROWS), Activity on its newest 100 steps.
    expect(initial).toEqual({ messages: 40, steps: 100, outputViewers: 0 });
    const activityPane = page
      .getByRole("complementary", { name: "Plan and steps" })
      .locator(".activity-scroll");
    await activityPane.evaluate((pane) => {
      pane.scrollTop = 100;
      pane.dispatchEvent(new Event("scroll"));
    });
    const selectedStep = page.getByTestId("tool-row").first().locator(".activity-row-title");
    const selectedStepText = await selectedStep.textContent();
    await selectedStep.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      Object.defineProperty(window, "selectedActivityNode", { value: element });
    });
    const incomingStep = ulid();
    f.session.append("step.start", { kind: "shell" }, incomingStep);
    f.session.append("tool.start", { tool: "shell", title: "New Activity marker" }, incomingStep);
    f.session.append("tool.end", { ok: true, exitCode: 0 }, incomingStep);
    f.session.append("step.end", { status: "ok" }, incomingStep);
    await expect(page.getByTestId("tool-row").last()).toContainText("New Activity marker");
    expect(await selectedStep.textContent()).toBe(selectedStepText);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(selectedStepText);
    expect(
      await selectedStep.evaluate(
        (node) =>
          node === (window as unknown as { selectedActivityNode: Element }).selectedActivityNode,
      ),
    ).toBe(true);
    expect((await counts(page)).steps).toBe(101);
    await page
      .locator(".activity-rail")
      .getByRole("button", { name: "Jump to latest", exact: true })
      .click();
    await expect(page.getByTestId("tool-row").last()).toContainText("New Activity marker");
    await showChat(page);
    await page.getByRole("button", { name: "Show earlier messages", exact: true }).focus();
    await page.keyboard.press("Enter");
    const text = page.locator(".thread-message :is(.thread-bubble, .safe-markdown p)");
    const selected = await text.first().textContent();
    expect(selected).toMatch(/^Recorded message \d+$/);
    await text.first().evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      Object.defineProperty(window, "selectedMessageNode", { value: element });
    });
    f.session.append("message.user", {
      messageId: ulid(),
      kind: "steer",
      text: "New live history marker",
    });
    await expect(page.getByRole("button", { name: "1 new message", exact: true })).toBeVisible();
    await expect(text.first()).toHaveText(selected ?? "");
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(selected);
    expect(
      await text
        .first()
        .evaluate(
          (node) =>
            node === (window as unknown as { selectedMessageNode: Element }).selectedMessageNode,
        ),
    ).toBe(true);
    await page.getByRole("button", { name: "1 new message", exact: true }).click();
    await expect(page.locator("article.thread-message").last()).toContainText(
      "New live history marker",
    );
    await showActivity(page);
    const outputRow = page.getByRole("button", { name: /Replay command 5000/ });
    await outputRow.click();
    await expect(page.getByRole("region", { name: "Command output", exact: true })).toContainText(
      "Shortened to the kept text.",
    );
    expect(await page.locator(".terminal-text").innerText()).toContain("Long recorded line");
    expect((await page.locator(".terminal-text").innerText()).length).toBeLessThanOrEqual(65_536);
    await page.keyboard.press("Escape");
    await expect(outputRow).toBeFocused();
    await expect(page.locator(".terminal-viewer")).toHaveCount(0);
    const replayCounts = [];
    for (let n = 0; n < 3; n++) {
      await p.replay();
      f.session.append("message.user", {
        messageId: ulid(),
        kind: "steer",
        text: `Replay barrier ${n}`,
      });
      // The new event follows all duplicate packets on this socket, proving each replay drained.
      await expect(page.locator("article.thread-message").last()).toContainText(
        `Replay barrier ${n}`,
      );
      const c = await counts(page);
      replayCounts.push(c);
      expect(c.messages).toBeLessThanOrEqual(200);
      expect(c.steps).toBeLessThanOrEqual(200);
      expect(c.outputViewers).toBe(0);
    }
    await page.screenshot({
      path: info.outputPath("bounded-history-before-stop-1280.png"),
      fullPage: true,
    });
    const stopReplay = p.replay();
    await page.getByTestId("hud-stop-session").click();
    await expect.poll(() => f.effects.includes("task-stop")).toBe(true);
    const timing = await page.evaluate(
      () =>
        (window as unknown as { stopTiming: { clickAt: number; dispatchMs: number } }).stopTiming,
    );
    expect(timing.dispatchMs).toBeGreaterThanOrEqual(0);
    expect(timing.dispatchMs).toBeLessThan(100);
    await stopReplay;
    await proof(page, p.errors, p.external);
    await attachEvidence(info, "history-performance.json", {
      body: JSON.stringify(
        {
          fixture:
            "actual production App/authenticated HTTP and WebSocket routes and durable journal; inert desktop/account/keyd edges",
          chrome: browser.version(),
          viewport: { width: 1280, height: 900 },
          dpr: 2,
          ...history,
          initial,
          replayCounts,
          actualSameSessionReconnects: 4,
          stopHandlerDispatchMs: timing.dispatchMs,
          stopEffects: f.effects,
          outputLimit: 65_536,
          screenReader:
            "DOM live-region boundaries checked; actual assistive technology unverified",
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    await page.screenshot({ path: info.outputPath("bounded-history-1280.png"), fullPage: true });
  } finally {
    await context.close();
    await f.close();
  }
});

for (const width of [390, 640])
  test(`keyboard toolbar and history controls at ${width}px${width === 640 ? " (200-percent desktop zoom layout)" : " phone"}`, async ({
    browser,
  }, info) => {
    const context = await browser.newContext({
      viewport: { width, height: 850 },
      deviceScaleFactor: 2,
      hasTouch: width === 390,
    });
    const page = await context.newPage();
    const f = await fixture();
    try {
      await seed(f, 600);
      const p = await load(page, f);
      // A phone's toolbar: Activity opens its sheet, whose own pages step through older steps.
      const activity = page.getByRole("button", { name: "Activity", exact: true });
      await activity.focus();
      await page.keyboard.press("Enter");
      const sheet = page.getByRole("dialog", { name: "Activity" });
      await sheet.getByRole("button", { name: "Earlier steps", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(sheet.getByTestId("tool-row").first()).toContainText("Replay command 101");
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      await expect(activity).toBeFocused();
      await page.getByRole("button", { name: "Show earlier messages", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("article.thread-message").first()).toContainText(
        "Recorded message",
      );
      // Jump to latest is inert until the thread has left the latest rows; only then can it take
      // the focus.
      const latest = page.getByRole("button", { name: "Jump to latest", exact: true });
      await expect(async () => {
        await latest.focus();
        await expect(latest).toBeFocused({ timeout: 200 });
      }).toPass();
      await page.keyboard.press("Enter");
      await expect(page.locator("article.thread-message").last()).toContainText(
        "Recorded message 300",
      );
      expect(
        await page.locator(".thread-scroll").evaluate((element) => element.clientHeight),
      ).toBeGreaterThanOrEqual(160);
      const options = page.getByRole("button", { name: "Recovery options", exact: true });
      await options.focus();
      await page.keyboard.press("Enter");
      await expect(options).toHaveAttribute("aria-expanded", "true");
      const taskCheck = page.getByRole("button", { name: "Check task state", exact: true });
      await taskCheck.focus();
      await expect(taskCheck).toBeFocused();
      const checkBox = await taskCheck.boundingBox();
      expect(checkBox).not.toBeNull();
      expect(checkBox?.y).toBeGreaterThanOrEqual(0);
      expect((checkBox?.y ?? 850) + (checkBox?.height ?? 44)).toBeLessThanOrEqual(850);
      await expect(page.getByRole("button", { name: "Send answer", exact: true })).toBeDisabled();
      expect(await page.locator(".island [role=status]").count()).toBe(1);
      // Settings and Keys open from More, over the page, and give the focus back to it.
      const more = page.getByRole("button", { name: "More", exact: true });
      for (const item of ["Settings", "Keys"]) {
        await more.focus();
        await page.keyboard.press("Enter");
        await page.getByRole("menuitem", { name: item, exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect(settingsSheet(page)).toBeVisible();
        await expect(page.getByTestId("hud-stop-session")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(settingsSheet(page)).toBeHidden();
        await expect(more).toBeFocused();
      }
      await proof(page, p.errors, p.external);
      await attachEvidence(info, "accessibility-layout.json", {
        body: JSON.stringify(
          {
            chrome: browser.version(),
            width,
            dpr: 2,
            toolbarKeyboardTraversal: true,
            explicitHistoryKeyboardNavigation: true,
            settingsKeysEscapeReturn: true,
            stopVisible: true,
            actualBrowserMenuZoom:
              "unverified; 640 CSS pixels exercises the 1280-at-200-percent reflow size",
            assistiveTechnology:
              "unverified; named regions, inert hidden panes and live-region DOM verified",
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      await page.screenshot({
        path: info.outputPath(`history-layout-${width}.png`),
        fullPage: true,
      });
    } finally {
      await context.close();
      await f.close();
    }
  });
