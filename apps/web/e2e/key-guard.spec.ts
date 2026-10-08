import { type Browser, expect, test, webkit } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";

let fixture: UiFixture | undefined;
test.afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});
test.setTimeout(60_000);

const KEY = `sk-ant-api03-${"z".repeat(40)}`;

async function phonePage(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  return context.newPage();
}

for (const engine of ["chrome", "webkit"] as const)
  test(`a ${engine} phone can discard a detected key and send the rest`, async ({ browser }) => {
    const owned = engine === "webkit" ? await webkit.launch({ channel: undefined }) : null;
    const page = await phonePage(owned ?? browser);
    try {
      fixture = await startUiFixture();
      const sent: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/messages"))
          sent.push(request.postData() ?? "");
      });
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      await page.getByRole("tab", { name: "Conversation" }).tap();
      const box = page.getByRole("textbox", { name: "Message" });
      await box.fill(`token ${KEY} please`);
      const send = page.getByRole("button", { name: "Send now" });
      await expect(send).toBeDisabled();
      await expect(
        page.getByRole("region", { name: "Key safeguard" }).getByRole("alert"),
      ).toContainText("Discard it or move it to Keys");
      await expect(page.getByRole("button", { name: "Edit message" })).toHaveCount(0);
      await box.pressSequentially(" continue");
      await expect(send).toBeDisabled();
      await page.getByRole("button", { name: "Discard keys and edit" }).tap();
      await expect(page.getByRole("region", { name: "Key safeguard" })).toHaveCount(0);
      await expect(box).toBeFocused();
      await expect(send).toBeEnabled();
      await send.tap();
      await expect.poll(() => sent.length).toBe(1);
      expect(JSON.parse(sent[0] as string)).toEqual({
        kind: "steer",
        text: "token  please continue",
      });
      expect(sent.join("")).not.toContain("sk-ant-api03");
    } finally {
      await page.context().close();
      await owned?.close();
    }
  });
