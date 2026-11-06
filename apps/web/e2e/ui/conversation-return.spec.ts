import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test.setTimeout(120_000);

// Reading through 180 rows takes a good many page moves.
const reading = { intervals: [100], timeout: 60_000 };

test("scrolling back down through history reaches the latest messages", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/say?n=180&text=History%20message`);
  const scroll = page.locator(".thread-scroll");
  const messages = scroll.locator("article.thread-message");
  await expect(messages.last()).toContainText("History message (180)");
  await expect(async () => {
    await scroll.dispatchEvent("wheel", { deltaY: -800 });
    await scroll.evaluate((e) => {
      e.scrollTop = 0;
      e.dispatchEvent(new Event("scroll"));
    });
    await ui.settle();
    await expect(scroll.locator(".thread-newer")).toBeAttached({ timeout: 200 });
  }).toPass(reading);
  await expect
    .poll(async () => {
      await scroll.dispatchEvent("wheel", { deltaY: 800 });
      await scroll.evaluate((e) => {
        e.scrollTop = e.scrollHeight;
        e.dispatchEvent(new Event("scroll"));
      });
      return page.locator(".thread-jump").getAttribute("data-shown");
    }, reading)
    .toBeNull();
  await expect(messages.last()).toContainText("History message (180)");
  await expect(scroll.locator(".thread-newer")).toHaveCount(0);
  await expect
    .poll(async () => {
      await scroll.dispatchEvent("wheel", { deltaY: 800 });
      await scroll.evaluate((e) => {
        e.scrollTop = e.scrollHeight;
        e.dispatchEvent(new Event("scroll"));
      });
      return scroll.locator(".thread-row").count();
    }, reading)
    .toBeLessThanOrEqual(40);
});

test("a later-page marker keeps loading until it is out of reach, and leaves the reader where they are", async ({
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
  const toPageEnd = async () => {
    await scroll.dispatchEvent("wheel", { deltaY: 800 });
    await scroll.evaluate((e) => {
      e.scrollTop = e.scrollHeight;
      e.dispatchEvent(new Event("scroll"));
    });
  };
  await toPageEnd();
  // Rows come in below by themselves until the marker is far from the view; the view stays put.
  const marker = () =>
    scroll.evaluate((e) => {
      const later = e.querySelector(".thread-newer")?.getBoundingClientRect();
      return later ? later.top - e.getBoundingClientRect().bottom : Number.POSITIVE_INFINITY;
    });
  await expect.poll(marker).toBeGreaterThan(300);
  await expect(page.locator(".thread-jump")).toHaveAttribute("data-shown");
  // Reading on, the reader reaches the latest rows, and follows from there.
  await expect
    .poll(async () => {
      await toPageEnd();
      return page.locator(".thread-jump").getAttribute("data-shown");
    }, reading)
    .toBeNull();
  await expect(messages.last()).toContainText("History message (180)");
  await expect(scroll.locator(".thread-newer")).toHaveCount(0);
  await expect
    .poll(async () => {
      await toPageEnd();
      return scroll.locator(".thread-row").count();
    }, reading)
    .toBeLessThanOrEqual(40);
});
