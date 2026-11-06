import { mkdirSync } from "node:fs";
import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, isPhone, runAt, test } from "./harness.ts";

// A toast from another task: how it looks, and that Open goes to the task rather than its recording.
runAt("c14", "c39", "w39");

const SHOTS = new URL("../out/toast-open/", import.meta.url).pathname;
const LONG = "Compare the 9:40 and 11:15 fares for the trip to Kyoto and book the cheaper one";

async function attention(page: Page) {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/api\/events$/, (socket) => {
    socket.connectToServer();
    sockets.push(socket);
  });
  await expect.poll(() => sockets.length).toBe(0);
  return (item: Record<string, unknown>) => {
    for (const socket of sockets)
      socket.send(JSON.stringify({ type: "attention.change", item, page: false }));
  };
}

const toast = (page: Page) => page.locator(".ui-toast:not([data-leaving])");

test("a toast's action and close button sit level with its words, in each look", async ({
  page,
  ui,
}) => {
  const raise = await attention(page);
  const fixture = await ui.open("conversations");
  const other = await otherConversation(page, fixture.origin);
  mkdirSync(SHOTS, { recursive: true });
  for (const appearance of ["graphite", "daylight"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    for (const [name, task] of [
      ["short", `Pay the electricity bill in ${appearance}`],
      ["long", `${LONG.slice(0, 70)} ${appearance}`],
    ] as const) {
      await expect(async () => {
        raise({
          key: `${appearance}:${name}`,
          sessionId: other,
          level: "done",
          reason: "done",
          task,
          at: 1,
        });
        await expect(toast(page)).toContainText(task, { timeout: 1_000 });
      }).toPass();
      const middle = (box: { y: number; height: number } | null) =>
        box ? box.y + box.height / 2 : Number.NaN;
      const [body, open, close, words] = await Promise.all([
        toast(page).locator(".ui-toast-body").boundingBox(),
        toast(page).getByRole("button", { name: "Open" }).boundingBox(),
        toast(page).getByRole("button", { name: "Dismiss" }).boundingBox(),
        toast(page).locator(".ui-toast-text").boundingBox(),
      ]);
      expect(Math.abs(middle(open) - middle(body))).toBeLessThanOrEqual(1);
      expect(Math.abs(middle(close) - middle(body))).toBeLessThanOrEqual(1);
      expect(Math.abs(middle(words) - middle(body))).toBeLessThanOrEqual(1);
      const width = page.viewportSize()?.width ?? 0;
      expect((body?.x ?? -1) >= 0 && (body?.x ?? 0) + (body?.width ?? 0) <= width).toBe(true);
      await page.screenshot({
        path: `${SHOTS}${test.info().project.name}-${appearance}-${name}.png`,
        clip: { x: 0, y: 0, width, height: 220 },
        animations: "disabled",
      });
      await toast(page).getByRole("button", { name: "Dismiss" }).click();
      await expect(toast(page)).toHaveCount(0);
    }
  }
});

test("Open on another task's toast goes to that task, not its recording", async ({ page, ui }) => {
  const raise = await attention(page);
  const fixture = await ui.open("conversations");
  const other = await otherConversation(page, fixture.origin);
  await expect(async () => {
    raise({
      key: `${other}:approval`,
      sessionId: other,
      level: "needs_you",
      reason: "approval",
      task: "Rename the holiday photos",
      at: 1,
    });
    await expect(toast(page)).toContainText("dot needs you", { timeout: 1_000 });
  }).toPass();
  const chosen = page.waitForRequest((request) =>
    request.url().endsWith("/api/conversation/continue"),
  );
  await toast(page).getByRole("button", { name: "Open" }).click();
  expect((await chosen).postDataJSON()).toEqual({ sessionId: other });
  await expect(page.getByRole("main", { name: "Replay" })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("replay")).toBeNull();
  if (!isPhone(page))
    await expect(
      page.getByRole("navigation", { name: "Conversations" }).locator("[data-current]"),
    ).toHaveAttribute("data-flip", other);
});

async function otherConversation(page: Page, origin: string): Promise<string> {
  const reply = await page.request.get(`${origin}/api/conversations`, {
    headers: { authorization: `Bearer ${"a".repeat(43)}` },
  });
  const { conversations } = (await reply.json()) as { conversations: { sessionId: string }[] };
  const other = conversations[1]?.sessionId;
  if (!other) throw new Error("The fixture has a second conversation");
  return other;
}
