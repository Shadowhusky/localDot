import type { Page } from "@playwright/test";
import { TOKEN, type UiFixture } from "../fixtures/start-ui-fixture.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");

const OTHER_MODEL = { provider: "openai", model: "gpt-6.1-sol" };
const LINKS = {
  "Replay off": {},
  "Replay on": { replay: true },
  "the owner's apps, keys and browser": { apps: true },
  "chat settings and model switching": {
    settings: true,
    chooseModel: true,
    models: [{ provider: "anthropic", model: "claude-sonnet-5-5" }, OTHER_MODEL],
  },
};

interface Conversation {
  sessionId: string;
  title: string;
}

// The owner's conversations, through the daemon's own routes; one of the past ones archived.
async function ownerSide(page: Page, fixture: UiFixture) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  const list = async (archived = false) =>
    (
      await (
        await page.request.get(
          `${fixture.origin}/api/conversations${archived ? "?archived=1" : ""}`,
          { headers },
        )
      ).json()
    ).conversations as Conversation[];
  const past = (await list()).filter((each) => each.sessionId !== fixture.sessionId);
  const archived = past.find((each) => each.title.startsWith("Find a plumber"));
  if (!archived) throw new Error("The fixture has no past conversations");
  const reply = await page.request.post(
    `${fixture.origin}/api/conversations/${archived.sessionId}/archive`,
    { headers, data: { archived: true } },
  );
  expect(reply.status()).toBe(204);
  expect((await list(true)).map((each) => each.sessionId)).toEqual([archived.sessionId]);
  const shown = await (
    await page.request.get(`${fixture.origin}/api/conversation`, { headers })
  ).json();
  expect(shown.sessions.at(-1)).toBe(fixture.sessionId);
  expect(shown.sessions.length).toBeGreaterThan(1);
  return {
    shown: shown.sessions as string[],
    others: past.map((each) => each.sessionId),
  };
}

for (const [name, setting] of Object.entries(LINKS))
  test(`a guest sees the conversation on show and its own task, and nothing else (${name})`, async ({
    page,
    ui,
  }) => {
    const fixture = await ui.open("shared-links", undefined, "");
    const owner = await ownerSide(page, fixture);
    const { token } = await (
      await page.request.post(`${fixture.origin}/__qa/link`, { data: setting })
    ).json();
    const guest = (path: string) =>
      page.request.get(`${fixture.origin}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const refused: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 403) refused.push(new URL(response.url()).pathname);
    });

    await page.goto(`${fixture.origin}/#token=${token}`);
    const main = page.getByRole("main");
    await expect(main).toHaveClass("shared-app");
    const chat = page.getByRole("region", { name: "Conversation" });
    await expect(chat.getByText(/^Summarise the sample sales table/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Replays", exact: true })).toHaveCount(
      "replay" in setting ? 1 : 0,
    );
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(
      "settings" in setting ? 1 : 0,
    );

    for (const path of ["/api/conversations", "/api/conversations?archived=1"])
      expect((await guest(path)).status(), path).toBe(403);
    expect(owner.others.length).toBeGreaterThan(4);
    for (const sessionId of owner.others) {
      for (const part of ["stream", "clock"])
        expect((await guest(`/api/sessions/${sessionId}/${part}`)).status(), part).toBe(403);
      expect((await guest(`/api/agent/sessions/${sessionId}`)).status()).toBe(403);
      for (const part of ["events", "history"])
        expect((await guest(`/api/sessions/${sessionId}/${part}`)).status(), part).toBe(
          "replay" in setting ? 200 : 403,
        );
      if (!("replay" in setting))
        expect((await guest(`/api/sessions/${sessionId}/card`)).status()).toBe(403);
    }
    for (const sessionId of owner.shown)
      expect((await guest(`/api/sessions/${sessionId}/history`)).status()).toBe(200);

    const box = page.getByRole("textbox", { name: "Message dot" });
    await box.fill("Water the plants on Friday");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(chat.getByText("Sample reply: I received the task.")).toBeVisible();
    await expect(chat.getByText("Water the plants on Friday")).toBeVisible();
    const { ownedSessions } = await (await guest("/api/remote-session")).json();
    expect(ownedSessions).toHaveLength(1);
    expect((await guest(`/api/sessions/${ownedSessions[0]}/history`)).status()).toBe(200);
    expect((await guest(`/api/agent/sessions/${ownedSessions[0]}`)).status()).toBe(200);

    // The web browser is signed in as the owner: only a link with their apps watches it.
    const moved = await page.request.post(`${fixture.origin}/__qa/screen?to=browser`);
    expect(moved.ok()).toBe(true);
    await expect(page.locator(".shared-screen-status")).toHaveText(
      "apps" in setting ? "Browser" : "Computer",
    );

    if ("replay" in setting) {
      await page.getByRole("button", { name: "Replays", exact: true }).click();
      const replays = page.getByRole("dialog", { name: "Replays" });
      await replays.getByRole("button", { name: /Organize the sample workspace/ }).click();
      await expect(page.getByRole("button", { name: "Live screen" })).toBeVisible();
      await page.getByRole("button", { name: "Live screen" }).click();
    }
    if ("settings" in setting) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "Chat settings" });
      await expect(sheet.getByText("1 of 5 tasks used.")).toBeVisible();
      await expect(sheet.getByRole("combobox", { name: "Model" })).toBeVisible();
    }
    const field = await box.boundingBox();
    expect(
      field && field.x >= 0 && field.x + field.width <= (page.viewportSize()?.width ?? 0),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`shared-${isPhone(page) ? "phone" : "desktop"}.png`),
    });
    expect(refused, "requests the guest's page made that were refused").toEqual([]);
  });
