import { composer, expect, runAt, test } from "./harness.ts";

// The browser's online flag guesses at internet access and is often wrong after sleep, on a
// network switch or with no internet at all, while localDot still answers on localhost or the
// tailnet. The page must act on what localDot answers, never on that guess.
runAt("c14");

test("offers Take control, sends a message and stops the task while the browser guesses it is offline", async ({
  page,
  ui,
}) => {
  await page.context().setOffline(false);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => false });
  });
  const fixture = await ui.open("ready");
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await expect(
    page.locator(".island").getByRole("button", { name: "Take control", exact: true }),
  ).toBeEnabled();
  expect((await page.request.post(`${fixture.origin}/__qa/reply?ms=600000`)).ok()).toBe(true);
  const card = await composer(page);
  const field = card.getByRole("textbox", { name: /^(New task|Message)$/ });
  await field.fill("Draw a dog");
  await card.getByRole("button", { name: /^(Start task|Send)$/ }).click();
  const sent = page.getByRole("article", { name: "You", exact: true }).filter({
    hasText: "Draw a dog",
  });
  await expect(sent).toHaveCount(1);
  await expect(field).toHaveValue("");
  await card.getByRole("button", { name: "Stop task" }).click();
  // Stop reached the task: what dot had not acted on comes back to the composer.
  await expect(field).toHaveValue("Draw a dog");
  await expect(sent).toHaveCount(0);
  await expect(page.getByText(/offline/i)).toHaveCount(0);
});
