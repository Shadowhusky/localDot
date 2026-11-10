import { expect, runAt, test } from "./harness.ts";

// A real Needs you, raised as the daemon raises it, while localDot is open in a tab on this Mac
// behind another app, in a browser that lets the tab show notifications. The fixture records what
// would reach the Mac's own banner (GET /__qa/notify): that banner is the one Send a test shows,
// so it is what a real event must reach too. Whether macOS then draws it can't be tested here.
runAt("c14");

const NEEDS_YOU = {
  question: "/__qa/ask",
  approval: "/__qa/approval",
  "hand-over": "/__qa/takeover",
  "key refused": "/__qa/fix/key",
  "app to connect": "/__qa/fix/app",
  "computer paused": "/__qa/fix/computer-paused",
  "Docker stopped": "/__qa/fix/runtime",
  "keys locked": "/__qa/keys-locked",
  "model refused": "/__qa/stall/model-refused",
  "key to enter again": "/__qa/stall/key-reenter",
} as const;

for (const [name, route] of Object.entries(NEEDS_YOU))
  test(`${name} reaches the Mac's banner while a tab waits behind another app`, async ({
    page,
    ui,
  }) => {
    await page.addInitScript(() => {
      // The browser's notifications as a page sees them: allowed, and with no way to tell whether
      // the system then shows them.
      const made: string[] = [];
      class Quiet {
        static permission = "granted";
        onclick = null;
        constructor(title: string) {
          made.push(title);
        }
        close() {}
      }
      Object.assign(window, { pageNotifications: made });
      Object.defineProperty(window, "Notification", { value: Quiet, configurable: true });
      Document.prototype.hasFocus = () => false;
    });
    const fixture = await ui.open("running");
    await ui.settle();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    const banners = async () =>
      (
        (await (await page.request.get(`${fixture.origin}/__qa/notify`)).json()) as {
          mac: [string, string][];
        }
      ).mac;
    const before = (await banners()).length;
    expect((await page.request.post(`${fixture.origin}${route}`)).ok()).toBe(true);
    await expect
      .poll(async () => (await banners()).slice(before).map(([title]) => title), {
        timeout: 10_000,
      })
      .toEqual(["dot needs you"]);
    expect(
      await page.evaluate(
        () => (window as unknown as { pageNotifications: string[] }).pageNotifications,
      ),
    ).toEqual([]);
  });
