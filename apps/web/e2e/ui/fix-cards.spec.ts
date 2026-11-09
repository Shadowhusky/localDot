import type { Locator, Page } from "@playwright/test";
import { TOKEN, type UiFixture } from "../fixtures/start-ui-fixture.ts";
import { chooseView, composer, expect, isPhone, runAt, test } from "./harness.ts";

// What stops dot, fixed where dot said so: localDot's own card for each kind, in Chat and Studio, at
// desktop and phone widths, in light and dark. The routes behind them are the daemon's own.
runAt("c14", "c39", "w14", "w39");

const PASSPHRASE = "correct horse battery";
const KEY_VALUE = `sk-ant-api03-${"q".repeat(40)}`;
const VIEWS = ["chat", "studio"] as const;
const LOOKS = ["daylight", "graphite"] as const;

const auth = { authorization: `Bearer ${TOKEN}` };
const chatRail = async (page: Page) => page.getByRole("complementary", { name: "Conversation" });
const qa = async (page: Page, fixture: UiFixture, path: string) => {
  const reply = await page.request.post(`${fixture.origin}/__qa/${path}`);
  expect(reply.ok(), path).toBe(true);
};
async function pictured(page: Page, card: Locator, name: string, ui: { settle(): Promise<void> }) {
  const info = test.info();
  for (const look of LOOKS) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, look);
    // The app crossfades between looks.
    await page.waitForTimeout(600);
    await ui.settle();
    await card.screenshot({ path: info.outputPath(`${name}-${look}.png`) });
  }
  await page.screenshot({ path: info.outputPath(`${name}-whole.png`) });
  await page.evaluate(() => {
    document.documentElement.dataset.appearance = "graphite";
  });
}
// Whatever localDot keeps or shows of the task: its log, the page and the fixture's own record.
async function holdsNoSecret(page: Page, fixture: UiFixture, ...secrets: string[]) {
  const sessions = (await (
    await page.request.get(`${fixture.origin}/api/sessions`, { headers: auth })
  ).json()) as { id: string }[];
  const logs = await Promise.all(
    sessions.map(async ({ id }) =>
      (
        await page.request.get(`${fixture.origin}/api/sessions/${id}/events`, { headers: auth })
      ).text(),
    ),
  );
  const state = await (await page.request.get(`${fixture.origin}/__qa/state`)).text();
  const pageText = await page.content();
  for (const secret of secrets)
    for (const [where, text] of Object.entries({ logs: logs.join("\n"), state, pageText }))
      expect(text, `${where} holds a secret`).not.toContain(secret);
}
// One line of what happened, and no card or Done left.
async function leavesALine(rail: Locator, line: string | RegExp) {
  await expect(rail.locator(".thread-fix")).toHaveCount(0);
  await expect(rail.locator('.thread-row[data-kind="fix"]').getByText(line)).toBeVisible();
  await expect(rail.getByRole("button", { name: /^Done$/ })).toHaveCount(0);
  await rail.screenshot({ path: test.info().outputPath("after.png") });
}

for (const view of VIEWS)
  test.describe(`in ${view}`, () => {
    test.use({ viewStyle: view });

    test("locked keys unlock right in the conversation, and leave one line", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("keys-locked");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: "Unlock your saved keys" });
      await expect(card).toBeVisible();
      await expect(card.getByText("localDot", { exact: true })).toBeVisible();
      await pictured(page, card, "keys", ui);
      const field = card.getByLabel("Passphrase", { exact: true });
      await field.focus();
      await field.fill("not the passphrase");
      await page.keyboard.press("Enter");
      await expect(card.getByText("That passphrase doesn't unlock your saved keys.")).toBeVisible();
      await expect(field).toHaveValue("");
      await field.fill(PASSPHRASE);
      await page.keyboard.press("Enter");
      await leavesALine(rail, "Keys unlocked");
      await holdsNoSecret(page, fixture, PASSPHRASE, "not the passphrase");
    });

    test("a refused key is replaced from its card, and goes straight to Keys", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("fix-key");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: /key was refused/ });
      await expect(card).toBeVisible();
      await pictured(page, card, "key", ui);
      const field = card.getByRole("textbox").first();
      await field.fill(KEY_VALUE);
      await card.getByRole("button", { name: /save|re-enter/i }).click();
      await leavesALine(rail, /key saved/);
      await holdsNoSecret(page, fixture, KEY_VALUE);
    });

    test("a key that can't be used as stored resumes the stalled task once it's entered", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("running");
      await qa(page, fixture, "reenter");
      await qa(page, fixture, "stall/key-reenter");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: /Re-enter a saved key/ });
      await expect(card).toBeVisible();
      await expect(card.getByRole("button", { name: "Not now" })).toHaveCount(0);
      await card.getByRole("textbox").first().fill(KEY_VALUE);
      await card.getByRole("button", { name: /save|re-enter/i }).click();
      await leavesALine(rail, /key saved/);
    });

    test("a key changed outside localDot says so and opens Keys", async ({ page, ui }) => {
      const fixture = await ui.open("running");
      await qa(page, fixture, "rebound");
      await qa(page, fixture, "stall/key-rebound");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: /changed outside localDot/ });
      await expect(card).toBeVisible();
      await expect(card.getByRole("textbox")).toHaveCount(0);
      await pictured(page, card, "key-rebound", ui);
      await card.getByRole("button", { name: "Open Keys" }).click();
      await expect(page.getByRole("heading", { name: "Keys" }).first()).toBeVisible();
    });

    test("an app's ended sign-in connects from its card", async ({ page, ui }) => {
      const fixture = await ui.open("running");
      await qa(page, fixture, "connectors");
      await qa(page, fixture, "fix/app");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: "Connect Linear" });
      await expect(card).toBeVisible();
      await pictured(page, card, "app", ui);
      await card.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(card.getByRole("button", { name: "Open again" })).toBeVisible();
      const connect = (await (await page.request.get(`${fixture.origin}/__qa/connect`)).json()) as {
        state: string;
        redirect: string;
      };
      const tab = await page.context().newPage();
      await tab.goto(`${connect.redirect}?state=${connect.state}&code=the-code`);
      await tab.close();
      await leavesALine(rail, "Linear connected");
    });

    test("a refused model tries again, and holds through the try", async ({ page, ui }) => {
      const fixture = await ui.open("fix-model");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: /could not process/ });
      await expect(card).toBeVisible();
      await expect(card.getByRole("blockquote")).toContainText("From the provider, not localDot");
      await expect(card.getByRole("blockquote")).toContainText("400");
      await expect(card).not.toContainText(/settings/i);
      await expect(card.getByRole("button", { name: "Not now" })).toHaveCount(0);
      await pictured(page, card, "model", ui);
      await card.getByRole("button", { name: "Try again" }).click();
      await qa(page, fixture, "fix-model-answered");
      await leavesALine(rail, "The model answered again");
    });

    test("a model out of quota goes on with another, on the same task", async ({ page, ui }) => {
      const fixture = await ui.open("running");
      await qa(page, fixture, "stall/provider-limit");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: /credit or usage limit/ });
      await expect(card).toBeVisible();
      const picker = card.getByRole("combobox", { name: "Model" });
      await expect(picker).toBeVisible();
      await picker.click();
      const options = page.getByRole("option");
      await expect(options.first()).toBeVisible();
      const others = await options.allTextContents();
      expect(others.length).toBeGreaterThan(1);
      const current = (await picker.textContent())?.trim() ?? "";
      const other = others.find((name) => !current.includes(name.trim()));
      await page.getByRole("option", { name: other ?? "" }).click();
      await expect(page.getByRole("option")).toHaveCount(0);
      await pictured(page, card, "model-other", ui);
      await card.getByRole("button", { name: /^Continue with/ }).click();
      await leavesALine(rail, /^Switched to/);
      const state = (await (await page.request.get(`${fixture.origin}/__qa/state`)).json()) as {
        effects: string[];
      };
      expect(state.effects.some((effect) => effect.startsWith("model:"))).toBe(true);
    });

    test("a computer that went off turns on from its card", async ({ page, ui }) => {
      await ui.open("fix-computer");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: "Your computer is off" });
      await expect(card).toBeVisible();
      await expect(page.locator(".phone-notice")).toHaveCount(0);
      await pictured(page, card, "computer", ui);
      await card.getByRole("button", { name: "Turn on" }).click();
      await leavesALine(rail, "Your computer is back on");
    });

    test("a paused computer resumes from its card", async ({ page, ui }) => {
      await ui.open("fix-computer-paused");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: "Your computer is paused" });
      await expect(card).toBeVisible();
      await pictured(page, card, "computer-paused", ui);
      await card.getByRole("button", { name: "Resume" }).click();
      await leavesALine(rail, "Your computer is back on");
    });

    test("Docker starts from its card, and says when it can't", async ({ page, ui }) => {
      const fixture = await ui.open("fix-runtime");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: "Docker isn't running" });
      await expect(card).toBeVisible();
      await pictured(page, card, "runtime", ui);
      await qa(page, fixture, "fix-docker?starts=0");
      await card.getByRole("button", { name: "Start Docker" }).click();
      await expect(card).toContainText("couldn't start it from here");
      await qa(page, fixture, "fix-docker");
      await card.getByRole("button", { name: "Try again" }).click();
      await expect(card).toContainText("Docker is starting");
      await qa(page, fixture, "fix-docker-up");
      await leavesALine(rail, "Docker is running again");
    });

    test("Not now goes on every device, and leaves a line", async ({ page, ui }) => {
      await ui.open("fix-runtime");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: "Docker isn't running" });
      await card.getByRole("button", { name: "Not now" }).click();
      await leavesALine(rail, "You left Docker off");
    });
  });

// A message moves on from a card as from any other wait of dot's.
const box = (rail: Locator) => rail.getByRole("form", { name: "Message dot" });
const SAID = "Forget that, book the train instead";
const PRIVATE_HINT = "Sending moves on without fixing this. Messages aren't kept secret";
const SEND_HELD = "Send as a message — dot will read this";
async function moveOn(rail: Locator, hint: string) {
  const form = box(rail);
  const field = form.getByRole("textbox", { name: "Message", exact: true });
  await expect(field).toHaveAttribute("placeholder", "Or message dot");
  await field.fill(SAID);
  await expect(form.getByText(hint)).toBeVisible();
  await form.getByRole("button", { name: "Send now" }).click();
  if (hint === PRIVATE_HINT) await form.getByRole("button", { name: SEND_HELD }).click();
}
const HINT = "Sending moves on without fixing this";

for (const view of VIEWS)
  test.describe(`a message in ${view}`, () => {
    test.use({ viewStyle: view });

    test("moves on from the unlock card, keeping nothing typed into it", async ({ page, ui }) => {
      const fixture = await ui.open("keys-locked");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: "Unlock your saved keys" });
      await expect(card).toBeVisible();
      await card.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
      await moveOn(rail, PRIVATE_HINT);
      await leavesALine(rail, "Not unlocked: you sent a message instead");
      await expect(rail.getByRole("article", { name: "You", exact: true }).last()).toContainText(
        SAID,
      );
      await expect(
        rail
          .getByRole("region", { name: "Conversation history" })
          .getByText("I read your message and moved on"),
      ).toBeVisible();
      await holdsNoSecret(page, fixture, PASSPHRASE);
    });

    test("moves on from a key's card, keeping nothing typed into it", async ({ page, ui }) => {
      const fixture = await ui.open("fix-key");
      const rail = await chatRail(page);
      const card = rail.getByRole("region", { name: /key was refused/ });
      await card.getByRole("textbox").first().fill(KEY_VALUE);
      await moveOn(rail, PRIVATE_HINT);
      await leavesALine(rail, /key not saved: you sent a message instead/);
      await holdsNoSecret(page, fixture, KEY_VALUE);
    });

    test("moves a stalled model on, and the message says it ended the wait", async ({
      page,
      ui,
    }) => {
      await ui.open("fix-model");
      const rail = await chatRail(page);
      await expect(rail.getByRole("region", { name: /could not process/ })).toBeVisible();
      await moveOn(rail, HINT);
      await leavesALine(rail, "Model not changed: you sent a message instead");
      await expect(
        rail
          .getByRole("article", { name: "You", exact: true })
          .getByText("dot stopped waiting to read this"),
      ).toBeVisible();
      await expect(
        rail
          .getByRole("region", { name: "Conversation history" })
          .getByText("I read your message and moved on"),
      ).toBeVisible();
    });

    test("resumes nothing when what the card waited on is fixed afterwards", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("fix-runtime");
      const rail = await chatRail(page);
      await expect(rail.getByRole("region", { name: "Docker isn't running" })).toBeVisible();
      await moveOn(rail, HINT);
      await leavesALine(rail, "Docker not started: you sent a message instead");
      await qa(page, fixture, "fix-docker-up");
      await expect(rail.locator('.thread-row[data-kind="fix"]')).toHaveCount(1);
      await expect(rail.getByText("Docker is running again")).toHaveCount(0);
    });
  });

test("a card fixed elsewhere leaves a stopped task stopped, saying what moves it on", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await qa(page, fixture, "fix/runtime-stalled");
  const rail = await chatRail(page);
  await expect(rail.getByRole("region", { name: "Docker isn't running" })).toBeVisible();
  await qa(page, fixture, "fix-docker-up");
  await leavesALine(rail, "Docker is running again");
  const recovery = rail.getByRole("region", { name: "Task recovery" });
  await expect(recovery.getByRole("heading", { name: "That's fixed now" })).toBeVisible();
  const resumed = page.waitForResponse(
    (reply) => reply.url().endsWith("/resume") && reply.request().method() === "POST",
  );
  await recovery.getByRole("button", { name: "Continue" }).click();
  expect((await resumed).status()).toBe(204);
});

test("a message closes the card on every device", async ({ page, ui, context }) => {
  await ui.open("fix-runtime");
  const other = await context.newPage();
  await chooseView(other, "studio");
  await other.goto(page.url());
  const here = await chatRail(page);
  const there = await chatRail(other);
  await expect(there.locator(".thread-fix")).toHaveCount(1);
  await moveOn(here, HINT);
  await expect(there.locator(".thread-fix")).toHaveCount(0);
  await expect(there.getByText("Docker not started: you sent a message instead")).toBeVisible();
  await other.close();
});

test("a fix on one device clears the card on another", async ({ page, ui, context }) => {
  const fixture = await ui.open("fix-runtime");
  const other = await context.newPage();
  await chooseView(other, "studio");
  await other.goto(page.url());
  const here = await chatRail(page);
  const there = await chatRail(other);
  await expect(there.locator(".thread-fix")).toHaveCount(1);
  await here.getByRole("button", { name: "Not now" }).click();
  await expect(here.locator(".thread-fix")).toHaveCount(0);
  await expect(there.locator(".thread-fix")).toHaveCount(0);
  await expect(there.getByText("You left Docker off")).toBeVisible();
  await other.close();
  expect(fixture.origin).toBeTruthy();
});

test("one blocker keeps one card, through a repeat and a reload", async ({ page, ui }) => {
  const fixture = await ui.open("keys-locked");
  const rail = await chatRail(page);
  const card = rail.getByRole("region", { name: "Unlock your saved keys" });
  await expect(card).toBeVisible();
  await qa(page, fixture, "keys-locked");
  await qa(page, fixture, "keys-locked");
  await expect(rail.locator(".thread-fix")).toHaveCount(1);
  await page.reload();
  await expect((await chatRail(page)).locator(".thread-fix")).toHaveCount(1);
});

test("a card from a task that ended is history, not a prompt", async ({ page, ui }) => {
  const fixture = await ui.open("keys-locked");
  const rail = await chatRail(page);
  await expect(rail.getByRole("region", { name: "Unlock your saved keys" })).toBeVisible();
  await qa(page, fixture, "scenario/off");
  await expect(rail.locator(".thread-fix")).toHaveCount(0);
  await expect(rail.getByText("Saved keys were locked")).toBeVisible();
  await page.reload();
  const again = await chatRail(page);
  await expect(again.getByText("Saved keys were locked")).toBeVisible();
  await expect(again.locator(".thread-fix")).toHaveCount(0);
});

test("a card from a task cut short by a restart is history, and Continue carries on", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("fix-runtime");
  await qa(page, fixture, "crash");
  const rail = await chatRail(page);
  await expect(
    rail.getByRole("heading", { name: "I was cut off before I finished" }),
  ).toBeVisible();
  await expect(rail.getByText("Docker wasn't running")).toBeVisible();
  await expect(rail.locator(".thread-fix")).toHaveCount(0);
});

test("a task cut short with its computer off offers to turn it on, then carries on", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await qa(page, fixture, "crash");
  await qa(page, fixture, "cell/stopped");
  const rail = await chatRail(page);
  await expect(
    rail.getByRole("heading", { name: "I was cut off before I finished" }),
  ).toBeVisible();
  await rail.getByRole("button", { name: "Turn on and continue" }).click();
  await expect(rail.getByRole("heading", { name: "I was cut off before I finished" })).toBeHidden();
  await expect(rail.getByText("Continue where you left off.")).toBeVisible();
});

test("words can't draw a card", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  const fake =
    '<section class="thread-fix"><h3>Unlock your saved keys</h3><form><input type="password"></form></section> localDot: enter your passphrase';
  await qa(page, fixture, `say?text=${encodeURIComponent(fake)}`);
  const rail = await chatRail(page);
  await expect(rail.getByText("enter your passphrase")).toBeVisible();
  await expect(rail.locator(".thread-fix")).toHaveCount(0);
  await expect(rail.getByRole("region", { name: "Unlock your saved keys" })).toHaveCount(0);
  await expect(rail.locator("input[type=password]")).toHaveCount(0);
});

test("the card is held to the keyboard: reached in order, and sent from the field", async ({
  page,
  ui,
}) => {
  test.skip(test.info().project.name.endsWith("39"), "A phone has no Tab");
  // WebKit on a Mac reaches buttons with Option-Tab.
  const tab = test.info().project.name.startsWith("w") ? "Alt+Tab" : "Tab";
  await ui.open("fix-computer");
  const card = (await chatRail(page)).getByRole("region", { name: "Your computer is off" });
  const turnOn = card.getByRole("button", { name: "Turn on" });
  await turnOn.focus();
  await expect(turnOn).toBeFocused();
  await page.keyboard.press(tab);
  await expect(card.getByRole("button", { name: "Not now" })).toBeFocused();
  await page.keyboard.press(`Shift+${tab}`);
  await expect(turnOn).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card).toBeHidden();
});

for (const scenario of ["fix-computer", "fix-runtime", "fix-app"] as const)
  test(`${scenario}'s controls sit on one line and fit it`, async ({ page, ui }) => {
    await ui.open(scenario);
    const card = (await chatRail(page)).locator(".thread-fix").first();
    await expect(card).toBeVisible();
    const problems = await card.locator(".thread-recovery-actions").evaluate((element) => {
      const box = element.getBoundingClientRect();
      const buttons = [...element.querySelectorAll<HTMLElement>(".ui-button")].map((button) =>
        button.getBoundingClientRect(),
      );
      const top = buttons[0]?.top ?? 0;
      return buttons.flatMap((button, index) =>
        Math.abs(button.top - top) > 1 || button.right > box.right + 1 || button.left < box.left - 1
          ? [index]
          : [],
      );
    });
    expect(problems).toEqual([]);
    // Nothing runs past the card, at any width.
    const over = await card.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(over).toBeLessThanOrEqual(0);
  });

// What is typed in the message box while a secret field is up may be the secret: on any device it
// takes one more step to send, and none of it is kept.
test.describe("a secret and the message box", () => {
  const SECRET = "correct horse battery staple";
  const DRAFT = "localdot.composer-draft.v1";
  const auth = { authorization: `Bearer ${TOKEN}` };
  const logged = async (page: Page, origin: string) => {
    const tasks = (await (
      await page.request.get(`${origin}/api/sessions`, { headers: auth })
    ).json()) as { id: string }[];
    const logs = await Promise.all(
      tasks.map(async ({ id }) =>
        (await page.request.get(`${origin}/api/sessions/${id}/events`, { headers: auth })).text(),
      ),
    );
    return logs.join("\n");
  };
  const messageBox = async (page: Page) =>
    (await composer(page)).getByRole("textbox", { name: "Message", exact: true });
  // Return on a phone starts a new line; Send is what sends there.
  const trySending = async (page: Page) => {
    if (await isPhone(page))
      await (await composer(page)).getByRole("button", { name: "Send now" }).click();
    else await page.keyboard.press("Enter");
  };
  const held = async (page: Page) =>
    (await composer(page)).getByRole("button", { name: SEND_HELD });

  test("a card takes the keys from an empty box, so the passphrase goes to it", async ({
    page,
    ui,
  }) => {
    const fixture = await ui.open("running");
    const box = await messageBox(page);
    await box.click();
    await box.fill("please carry on");
    // A message can't go until the page has caught up with the task, and stays in the box till then.
    await expect(async () => {
      await trySending(page);
      await expect(box).toHaveValue("", { timeout: 2000 });
    }).toPass();
    await box.focus();
    await page.request.post(`${fixture.origin}/__qa/keys-locked`);
    const card = page.getByRole("region", { name: "Unlock your saved keys" });
    await expect(card.getByLabel("Passphrase")).toBeFocused();
    await page.keyboard.type(SECRET);
    await expect(box).toHaveValue("");
    await expect(card.getByLabel("Passphrase")).toHaveValue(SECRET);
    expect(await logged(page, fixture.origin)).not.toContain(SECRET);
  });

  test("a secret question's form takes the keys from an empty box", async ({ page, ui }) => {
    const fixture = await ui.open("running");
    const box = await messageBox(page);
    await box.focus();
    await page.request.post(`${fixture.origin}/__qa/ask?fields=login`);
    await expect(page.locator("form.ask input").first()).toBeFocused();
  });

  test("words already in the box keep the keys, and still don't go on Enter", async ({
    page,
    ui,
  }) => {
    const fixture = await ui.open("running");
    const box = await messageBox(page);
    await box.click();
    await page.keyboard.type("half a thought");
    await page.request.post(`${fixture.origin}/__qa/keys-locked`);
    await expect(page.getByRole("region", { name: "Unlock your saved keys" })).toBeVisible();
    await expect(box).toBeFocused();
    await trySending(page);
    await expect(await held(page)).toBeVisible();
    expect(await logged(page, fixture.origin)).not.toContain("half a thought");
  });

  for (const [name, start] of [
    ["the unlock card", "keys-locked"],
    ["a password on a login form", "login"],
  ] as const)
    test(`typed in the box during ${name}, it goes nowhere without the extra step`, async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open(start === "login" ? "running" : start);
      if (start === "login") await page.request.post(`${fixture.origin}/__qa/ask?fields=login`);
      await expect(page.locator('form.ask, [data-fix="keys_locked"]').first()).toBeVisible();
      const box = await messageBox(page);
      await box.click();
      await box.pressSequentially(SECRET);
      await trySending(page);
      await trySending(page);
      await expect(await held(page)).toBeVisible();
      await expect(await held(page)).not.toBeFocused();
      await page.waitForTimeout(600);
      expect(await logged(page, fixture.origin)).not.toContain(SECRET);
      await box.blur();
      expect(await page.evaluate((key) => localStorage.getItem(key), DRAFT)).toBeNull();
      await ui.settle();
      await page.screenshot({
        path: test.info().outputPath(`held-${start}.png`),
      });
      await (await held(page)).click();
      await expect.poll(() => logged(page, fixture.origin)).toContain(`"text":"${SECRET}"`);
    });

  test("nothing typed during the wait outlives a reload", async ({ page, ui }) => {
    await ui.open("keys-locked");
    await expect(page.getByRole("region", { name: "Unlock your saved keys" })).toBeVisible();
    const box = await messageBox(page);
    await box.click();
    await box.pressSequentially(SECRET);
    await page.waitForTimeout(600);
    await page.reload();
    await expect(page.getByRole("region", { name: "Unlock your saved keys" })).toBeVisible();
    await expect(await messageBox(page)).toHaveValue("");
  });
});
