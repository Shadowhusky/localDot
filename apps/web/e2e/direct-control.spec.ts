import { expect, type Page, test } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";

test.setTimeout(90_000);

let fixture: UiFixture | undefined;
test.afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

interface Delivered {
  at: number;
  input: { kind: string; text?: string; combo?: string[]; button?: string };
}
const delivered = async (page: Page, origin: string): Promise<Delivered[]> =>
  (await page.request.get(`${origin}/__qa/manual-inputs`)).json();
// The keyboard part of what reached the computer, with typing the daemon joined read as one run.
function keyboard(inputs: Delivered[]): (string | string[])[] {
  const out: (string | string[])[] = [];
  for (const { input } of inputs) {
    if (input.kind === "key") out.push(input.combo ?? []);
    else if (input.kind === "text") {
      const last = out.length - 1;
      if (typeof out[last] === "string") out[last] += input.text ?? "";
      else out.push(input.text ?? "");
    }
  }
  return out;
}

async function takeControl(page: Page) {
  fixture = await startUiFixture();
  const origin = fixture.origin;
  await page.addInitScript(() => {
    const keys: number[] = [];
    Object.defineProperty(window, "keystrokes", { value: keys });
    window.addEventListener("keydown", () => keys.push(Date.now()), true);
  });
  await page.goto(`${origin}/#token=${TOKEN}`);
  await page.request.post(`${origin}/__qa/takeover`);
  // dot hands the computer over; it is the user's once they take it.
  await page.getByRole("button", { name: "Take control" }).click();
  await expect(page.getByRole("button", { name: "Hand back" })).toBeEnabled();
  const keys = page.getByLabel("Type on the computer");
  await expect(keys).toBeEnabled();
  const surface = page.locator(".manual-surface");
  const box = await surface.boundingBox();
  if (!box) throw new Error("The computer view is missing");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(keys).toBeFocused();
  await expect(surface).toHaveAttribute("data-typing", "");
  return origin;
}

test("typing on the computer while in control reaches it as one ordered stream", async ({
  page,
}) => {
  const origin = await takeControl(page);
  // The pointer glides onto the computer, then presses and lets go there.
  await expect
    .poll(async () =>
      (await delivered(page, origin))
        .map(({ input }) => input.kind)
        .filter((kind, i, all) => kind !== "move" || i === all.indexOf("move")),
    )
    .toEqual(["move", "down", "up"]);
  await page.keyboard.type("user@example.test");
  await page.keyboard.press("Tab");
  await page.keyboard.type("pass word!");
  await expect
    .poll(async () => keyboard(await delivered(page, origin)))
    .toEqual(["user@example.test", ["tab"], "pass word!"]);
  await page.getByRole("button", { name: "Hand back" }).click();
  await expect(page.getByRole("button", { name: "Hand back" })).toHaveCount(0);
  const journal = await (
    await page.request.get(`${origin}/api/sessions/${fixture?.sessionId}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
  ).text();
  expect(journal).toContain('"typed":true');
  expect(journal).not.toContain("pass word");
  expect(journal).not.toContain("user@example.test");
});

test("measures keystroke-to-computer latency over loopback", async ({ page }) => {
  const origin = await takeControl(page);
  const typed = "the quick brown fox jumps over the lazy dog 0123456789";
  await page.keyboard.type(typed, { delay: 40 });
  await expect.poll(async () => keyboard(await delivered(page, origin)).join("")).toBe(typed);
  const pressed: number[] = await page.evaluate(
    () => (window as unknown as { keystrokes: number[] }).keystrokes,
  );
  const arrivals: number[] = [];
  for (const { at, input } of await delivered(page, origin))
    if (input.kind === "text") for (const _ of input.text ?? "") arrivals.push(at);
  const latency = pressed.slice(-arrivals.length).map((at, i) => (arrivals[i] ?? at) - at);
  const sorted = [...latency].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const summary = { keys: sorted.length, median: pick(0.5), p95: pick(0.95), max: sorted.at(-1) };
  test.info().annotations.push({ type: "latency-ms", description: JSON.stringify(summary) });
  console.log(`keystroke to computer, loopback: ${JSON.stringify(summary)}`);
  expect(summary.p95).toBeLessThan(100);
});
