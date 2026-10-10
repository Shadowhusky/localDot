import { composer, expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test.use({ fixedClock: false });

test("returning to the app refreshes silent feeds without losing the draft or restarting the computer", async ({
  page,
  ui,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, { dropFeedMessages: false });
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          if ((window as unknown as { dropFeedMessages: boolean }).dropFeedMessages)
            event.stopImmediatePropagation();
        });
      }
    };
  });
  const fixture = await ui.open("running");
  const input = (await composer(page)).getByRole("textbox", { name: "Message" });
  await input.fill("Keep this unsent draft");
  await expect(
    (await composer(page)).getByRole("button", { name: "Queue message" }),
  ).not.toHaveAttribute("aria-disabled", "true");
  const url = page.url();
  const requests: string[] = [];
  const sockets: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") requests.push(new URL(request.url()).pathname);
  });
  page.on("websocket", (socket) => sockets.push(socket.url()));
  // Simulate the phone suspending message delivery without dispatching WebSocket.close.
  await page.evaluate(() => {
    Object.assign(window, { dropFeedMessages: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.request.post(`${fixture.origin}/__qa/stream?ms=1200`);
  // Wait for the fixture's task to advance while all client feeds remain silent.
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    Object.assign(window, { dropFeedMessages: false });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
  });
  await expect(page.locator(".thread-scroll")).toContainText("cell20");
  await expect(input).toHaveValue("Keep this unsent draft");
  expect(page.url()).toBe(url);
  expect(sockets.some((socket) => socket.includes("/status"))).toBe(true);
  expect(sockets.filter((socket) => socket.includes("/stream?fromSeq="))).toHaveLength(1);
  expect(requests.filter((path) => !path.endsWith("stream-ticket"))).toEqual([]);
});
