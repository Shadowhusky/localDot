import { expect, test } from "@playwright/test";
import { fixture, load, proof } from "./fixtures/recovery-server.ts";

test.setTimeout(60_000);
test.use({ hasTouch: true });

for (const width of [1280, 390])
  test(`explicit durable budget and finished-task memory Undo at ${width}px`, async ({
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
      const p = await load(page, f);
      if (width === 390) await page.getByRole("tab", { name: "Activity", exact: true }).click();
      const usage = page.getByRole("region", { name: "Task usage" });
      await expect(usage).toContainText("main · owned · sample-main");
      await expect(usage).toContainText("30 input · 7 output tokens");
      await expect(usage).toContainText("some calls did not report reasoning");
      await expect(page.getByRole("region", { name: "Available skills" })).toContainText(
        "sample-tables",
      );
      if (width === 390) await page.getByRole("tab", { name: "Conversation", exact: true }).click();
      const recovery = page.getByRole("region", { name: "Task recovery" });
      await expect(recovery).toContainText("ceiling $5, spent $4");
      const ceiling = page.getByLabel("New task ceiling (USD)");
      await expect(ceiling).toBeEnabled();
      await page.screenshot({
        path: info.outputPath(`before-recovery-${width}.png`),
        fullPage: true,
      });
      await ceiling.fill("0");
      await page.getByRole("button", { name: "Set task budget and resume" }).click();
      expect(f.raises).toEqual([]);
      await ceiling.fill("8");
      await recovery.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: info.outputPath(`recovery-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Set task budget and resume" }).click();
      await expect.poll(() => f.raises).toEqual([{ id: f.id, ceiling: 8 }]);
      expect(f.ledger).toEqual({ taskId: f.id, limit: 8, spent: 4 });
      await expect(recovery).toHaveCount(0);
      f.session.stop();
      f.session.append("session.end", { reason: "done" });
      if (width === 390) await page.getByRole("tab", { name: "Activity", exact: true }).click();
      const card = page.getByRole("region", { name: "Memory change" }).first();
      await expect(card.getByRole("button", { name: "Undo this change" })).toBeEnabled();
      await card.getByRole("button", { name: "Undo this change" }).click();
      await expect(card).toContainText("This change has already been undone.");
      expect(f.memory.readBoth().memory).not.toContain("Sample fact:");
      expect(f.log.read(f.id).findLast((e) => e.type === "memory.change")?.data).toMatchObject({
        undoes: f.remembered.changeId,
      });
      await page.getByRole("button", { name: "Read current memory" }).click();
      await expect(page.getByRole("region", { name: "Skills and memory" })).toContainText(
        "# Things worth remembering",
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await proof(page, p.errors, p.external);
    } finally {
      await context.close();
      await f.close();
    }
  });

test("plan windows remain unknown when absent and explicit Resume never raises USD", async ({
  page,
}, info) => {
  const f = await fixture("chatgpt");
  try {
    await page.setViewportSize({ width: 390, height: 850 });
    const p = await load(page, f);
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    const usage = page.getByRole("region", { name: "Task usage" });
    await expect(usage).toContainText("Main · ChatGPT · owned-plan-model");
    await expect(usage.getByRole("meter", { name: "primary plan usage" })).toHaveAttribute(
      "value",
      "98",
    );
    await expect(usage).toContainText("Usage unavailable · Reset time unavailable");
    await expect(page.getByLabel("New task ceiling (USD)")).toHaveCount(0);
    await page.getByRole("tab", { name: "Conversation", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume task" })).toBeEnabled();
    await expect(page.getByRole("region", { name: "Task recovery" })).not.toContainText(
      "ceiling $5",
    );
    const before = f.session.inboxSequence;
    await page.screenshot({
      path: info.outputPath("subscription-recovery-390.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Resume task" }).click();
    await expect.poll(() => f.session.inboxSequence).toBe(before + 1);
    expect(f.raises).toEqual([]);
    expect(f.ledger.spent).toBe(4);
    await proof(page, p.errors, p.external);
  } finally {
    await page.close();
    await f.close();
  }
});

test("memory conflict preserves the newer durable file and offers an explicit reread", async ({
  page,
}) => {
  const f = await fixture();
  try {
    const p = await load(page, f);
    f.memory.apply(f.id, "MEMORY.md", "append", "Newer fact must remain.");
    const card = page.getByRole("region", { name: "Memory change" }).first();
    await expect(card.getByRole("button", { name: "Undo this change" })).toBeEnabled();
    await card.getByRole("button", { name: "Undo this change" }).click();
    await expect(card).toContainText("Memory changed since this update.");
    expect(f.memory.readBoth().memory).toContain("Newer fact must remain.");
    await card.getByRole("button", { name: "Reread memory" }).click();
    await expect(page.getByRole("region", { name: "Skills and memory" })).toContainText(
      "Newer fact must remain.",
    );
    await proof(page, p.errors, p.external);
  } finally {
    await page.close();
    await f.close();
  }
});

for (const width of [1280, 390])
  test(`real runner retirement preserves read-only memory Undo at ${width}px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width, height: 850 },
      deviceScaleFactor: 2,
      hasTouch: width === 390,
    });
    const page = await context.newPage();
    const f = await fixture("chatgpt", "paused", true);
    try {
      const p = await load(page, f);
      await f.finish();
      if (width === 390) await page.getByRole("tab", { name: "Activity", exact: true }).click();
      const card = page.getByRole("region", { name: "Memory change" }).first();
      await expect(card.getByRole("button", { name: "Undo this change" })).toBeEnabled();
      expect(f.realRunner?.get(f.id)).toBeUndefined();
      await card.getByRole("button", { name: "Undo this change" }).click();
      await expect(card).toContainText("This change has already been undone.");
      expect(f.memory.readBoth().memory).not.toContain("Sample fact:");
      expect(f.log.read(f.id).findLast((e) => e.type === "memory.change")?.data).toMatchObject({
        undoes: f.remembered.changeId,
      });
      expect(f.realRunner?.get(f.id)).toBeUndefined();
      if (width === 390) await page.getByRole("tab", { name: "Conversation", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "New task", exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Resume task", exact: true })).toHaveCount(0);
      await proof(page, p.errors, p.external);
    } finally {
      await context.close();
      await f.close();
    }
  });
