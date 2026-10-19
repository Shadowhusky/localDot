import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

test("scrolling back down through history reaches the latest messages", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/say?n=180&text=History%20message`);
  const scroll = page.locator(".thread-scroll");
  const messages = scroll.locator("article.thread-message");
  await expect(messages.last()).toContainText("History message (180)");
  for (let i = 0; i < 4; i++) {
    await scroll.dispatchEvent("wheel", { deltaY: -800 });
    await scroll.evaluate((e) => {
      e.scrollTop = 0;
      e.dispatchEvent(new Event("scroll"));
    });
    await ui.settle();
  }
  await expect(scroll.locator(".thread-newer")).toBeAttached();
  await expect
    .poll(async () => {
      await scroll.dispatchEvent("wheel", { deltaY: 800 });
      await scroll.evaluate((e) => {
        e.scrollTop = e.scrollHeight;
        e.dispatchEvent(new Event("scroll"));
      });
      return messages.last().textContent();
    })
    .toContain("History message (180)");
  await expect(scroll.locator(".thread-newer")).toHaveCount(0);
  expect(await scroll.locator(".thread-row").count()).toBeLessThanOrEqual(40);
});

test("a later-page marker that stays visible keeps loading without a second scroll", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/say?n=180&text=History%20message`);
  const scroll = page.locator(".thread-scroll");
  const messages = scroll.locator("article.thread-message");
  await expect(messages.last()).toContainText("History message (180)");
  for (let i = 0; i < 5; i++) {
    await scroll.getByRole("button", { name: "Show earlier messages", exact: true }).focus();
    await page.keyboard.press("Enter");
  }
  await expect(messages.last()).not.toContainText("History message (180)");
  await scroll.dispatchEvent("wheel", { deltaY: 800 });
  await scroll.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
    e.dispatchEvent(new Event("scroll"));
  });
  await expect(messages.last()).toContainText("History message (180)");
  await expect(scroll.locator(".thread-newer")).toHaveCount(0);
  expect(await scroll.locator(".thread-row").count()).toBeLessThanOrEqual(40);
});
