import type { Page } from "@playwright/test";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { skipSetup } from "../skip-setup.ts";
import { chooseView, composer, expect, isPhone, runAt, test } from "./harness.ts";

// The message box works whatever dot is waiting for: a message sent then moves on from the wait, on
// every device, and dot reads it straight away.
runAt("c14", "c39", "w14", "w39");

const ASK = ".ask, .ask-quick, .private-key-request";
const REPLY = "Sample reply: I read your message and moved on.";
const SAID = "Forget that, book the train instead";

async function field(page: Page) {
  return (await composer(page)).getByRole("textbox", { name: "Message", exact: true });
}
async function send(page: Page, text = SAID) {
  await (await field(page)).fill(text);
  await (await composer(page)).getByRole("button", { name: "Send now" }).click();
}
// While a field for a secret is up, Send only brings up the step that says dot will read it.
async function sendPastSecret(page: Page, text = SAID) {
  await send(page, text);
  await expect(page.locator(ASK)).toHaveCount(1);
  await (await composer(page))
    .getByRole("button", { name: "Send as a message — dot will read this" })
    .click();
}
async function effects(page: Page, origin: string) {
  const state = (await (await page.request.get(`${origin}/__qa/state`)).json()) as {
    effects: string[];
  };
  return state.effects;
}
const history = (page: Page) => page.getByRole("region", { name: "Conversation history" });
const yours = (page: Page, text = SAID) =>
  page.getByRole("article", { name: "You", exact: true }).filter({ hasText: text });
// Once the page has come in, so what's on it shows whole.
async function shot(page: Page, name: string) {
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => null)),
    ),
  );
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}
// dot took up the message: it shows what it was, and dot answers it.
async function dotReadIt(page: Page) {
  await expect(yours(page).getByText("dot stopped waiting to read this")).toBeVisible();
  await expect(history(page).getByText(REPLY)).toBeVisible();
}

const SECRET_FORMS: ReadonlySet<string> = new Set(["login", "code", "a key"]);
for (const [name, path] of [
  ["a quick question", "/__qa/ask"],
  ["setup", "/__qa/ask?fields=setup"],
  ["login", "/__qa/ask?fields=login"],
  ["multichoice", "/__qa/ask?fields=multichoice"],
  ["details", "/__qa/ask?fields=details"],
  ["file", "/__qa/ask?fields=file"],
  ["qr", "/__qa/ask?fields=qr"],
  ["code", "/__qa/ask?fields=code"],
  ["a key", "/__qa/ask?fields=servicekey"],
  ["an app", "/__qa/ask?fields=connect"],
  ["a lone confirm", "/__qa/ask?fields=confirm"],
] as const)
  test(`a message moves on from dot's question: ${name}`, async ({ page, ui }) => {
    const fixture = await ui.open("running");
    expect((await page.request.post(`${fixture.origin}${path}`)).ok()).toBe(true);
    const box = await field(page);
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute("placeholder", "Or message dot");
    await expect(page.locator(ASK)).toHaveCount(1);
    await ui.settle();
    await shot(page, "waiting");
    await (SECRET_FORMS.has(name) ? sendPastSecret(page) : send(page));
    await expect(page.locator(ASK)).toHaveCount(0);
    await expect(page.getByText("Not answered: you sent a message instead.")).toBeVisible();
    await dotReadIt(page);
    expect((await effects(page, fixture.origin)).filter((e) => e.startsWith("ask:"))).toEqual([
      'ask:{"by":"message"}',
    ]);
    await ui.settle();
    await shot(page, "moved-on");
  });

test("a message sent now during a question is never its answer, even in its own words", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  const answers: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/answer")) answers.push(request);
  });
  await page.request.post(`${fixture.origin}/__qa/ask`);
  await expect(page.locator("form.ask")).toBeVisible();
  await send(page, "PDF");
  await expect(page.locator("form.ask")).toHaveCount(0);
  expect(answers).toEqual([]);
  await expect(yours(page, "PDF")).toBeVisible();
});

test("a question's form is still answered in the form", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/ask`);
  const form = page.locator("form.ask");
  await form.getByRole("radio", { name: "Markdown" }).check();
  await form.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect((await effects(page, fixture.origin)).at(-1)).toContain('"by":"user"');
  await expect(page.getByText("Not answered")).toHaveCount(0);
});

test("a key typed in the box while a secret form waits stays out of the message", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/ask?fields=login`);
  await expect(page.locator("form.ask")).toBeVisible();
  const box = await field(page);
  await box.fill(`sk-ant-api03-${"a1B2c3D4e5".repeat(8)}`);
  await expect(box).not.toHaveValue(/sk-ant-api03/);
  await expect(page.locator("form.ask")).toBeVisible();
  expect(await effects(page, fixture.origin)).toEqual([]);
});

test("a password typed in the form goes no further when a message moves on", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/ask?fields=login`);
  const form = page.locator("form.ask");
  const secret = "correct horse battery staple";
  await form.getByRole("textbox", { name: "Password", exact: true }).fill(secret);
  const seen: string[] = [];
  page.on("request", (request) => seen.push(request.postData() ?? ""));
  await (await field(page)).fill("Skip signing in");
  await expect(page.getByText("Messages aren't kept secret")).toBeVisible();
  await sendPastSecret(page, "Skip signing in");
  await expect(form).toHaveCount(0);
  await expect(history(page).getByText(REPLY)).toBeVisible();
  expect(seen.join("\n")).not.toContain(secret);
  await expect(page.getByText(secret)).toHaveCount(0);
});

test("a message counts as not approved: the card goes and the step never runs", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/approval?kind=send`);
  const approve = page.getByRole("button", { name: "Send", exact: true });
  await expect(approve).toBeVisible();
  const box = await field(page);
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute("placeholder", "Or message dot");
  await ui.settle();
  await shot(page, "approval-waiting");
  await box.fill(SAID);
  await expect(page.getByText("Sending moves on without approving")).toBeVisible();
  await (await composer(page)).getByRole("button", { name: "Send now" }).click();
  await expect(approve).toBeHidden();
  await expect(page.getByRole("article", { name: "Not approved" })).toContainText(
    "Send this email?",
  );
  await expect(
    page.getByText("Not approved: you sent a message instead, so it didn't run."),
  ).toBeVisible();
  await dotReadIt(page);
  expect((await effects(page, fixture.origin)).filter((e) => e.startsWith("approval"))).toEqual([
    'approval:"message"',
  ]);
  await ui.settle();
  await shot(page, "approval-moved-on");
});

test("a late Approve from another device is refused and runs nothing", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/approval?kind=send`);
  const headers = { authorization: `Bearer ${TOKEN}` };
  const session = `${fixture.origin}/api/agent/sessions/${fixture.sessionId}`;
  const held = (await (await page.request.get(session, { headers })).json()) as {
    approval: { approvalId: string; generation: number; revision: number };
  };
  await send(page);
  await dotReadIt(page);
  const late = await page.request.post(`${session}/approvals/answer`, {
    headers,
    data: {
      approvalId: held.approval.approvalId,
      generation: held.approval.generation,
      revision: held.approval.revision,
      decision: "approve",
    },
  });
  expect(late.status()).toBe(409);
  expect(await effects(page, fixture.origin)).toEqual(['approval:"message"']);
});

// Pressed on one device just as a message lands from another: the answer's own request loses.
for (const [name, path, press, answered] of [
  [
    "answer",
    "/__qa/ask",
    async (page: Page) => {
      const form = page.locator("form.ask");
      await form.getByRole("radio", { name: "Markdown" }).check();
      await form.getByRole("button", { name: "Send answer", exact: true }).click();
    },
    "**/answer",
  ],
  [
    "Approve",
    "/__qa/approval?kind=send",
    (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click(),
    "**/approvals/answer",
  ],
] as const)
  test(`a late ${name} is refused cleanly, leaving no error behind`, async ({ page, ui }) => {
    const fixture = await ui.open("running");
    await page.request.post(`${fixture.origin}${path}`);
    const refused: number[] = [];
    await page.route(answered, async (route) => {
      await page.request.post(
        `${fixture.origin}/api/agent/sessions/${fixture.sessionId}/messages`,
        { headers: { authorization: `Bearer ${TOKEN}` }, data: { text: SAID, kind: "steer" } },
      );
      const reply = await route.fetch();
      refused.push(reply.status());
      await route.fulfill({ response: reply });
    });
    await press(page);
    await expect.poll(() => refused).toEqual([409]);
    await dotReadIt(page);
    await expect(page.locator(ASK)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    await expect(page.getByText(/didn't reach dot|Request refused/)).toHaveCount(0);
    expect((await effects(page, fixture.origin)).join()).not.toContain('"by":"user"');
    expect((await effects(page, fixture.origin)).join()).not.toContain('"approve"');
  });

test("a message ends dot's hand-over and gives the computer back", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/takeover`);
  await expect(page.getByRole("button", { name: "Hand back" }).first()).toBeVisible();
  // A phone's toolbar holds the computer's controls: the field is one press away.
  if (isPhone(page)) {
    await shot(page, "handover-tools");
    await page.getByRole("button", { name: "Message dot" }).click();
    await expect(await field(page)).toBeFocused();
  }
  const box = await field(page);
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute("placeholder", "Or message dot");
  await ui.settle();
  await shot(page, "handover-waiting");
  await box.fill(SAID);
  await expect(page.getByText("Sending hands the computer back")).toBeVisible();
  await (await composer(page)).getByRole("button", { name: "Send now" }).click();
  await expect(page.getByRole("button", { name: "Hand back" })).toHaveCount(0);
  await expect(page.getByText("Your turn", { exact: true })).toHaveCount(0);
  await expect(page.getByText("You moved on with a message")).toBeVisible();
  await dotReadIt(page);
  expect((await effects(page, fixture.origin)).filter((e) => e.startsWith("takeover"))).toEqual([
    expect.stringContaining('"movedOn":true'),
  ]);
  await ui.settle();
  await shot(page, "handover-moved-on");
});

// The fixture's page isn't fresh on the browser screen, whose snapshot it doesn't keep, so this one
// sends through the route the composer sends through.
test("a message ends the sign-in card on the web browser too", async ({ page, ui }) => {
  await page.route("**/takeover/sign-in", (route) =>
    route.fulfill({
      status: 200,
      json: { available: true, mode: "standard", changing: false },
      headers: { "content-type": "application/json" },
    }),
  );
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/takeover`);
  await expect(page.getByRole("button", { name: "Hand back" }).first()).toBeVisible();
  expect((await page.request.post(`${fixture.origin}/__qa/screen?to=browser`)).ok()).toBe(true);
  await expect(page.locator(".thread-browser-signin")).toBeVisible();
  await ui.settle();
  await shot(page, "sign-in-waiting");
  const message = await page.request.post(
    `${fixture.origin}/api/agent/sessions/${fixture.sessionId}/messages`,
    {
      headers: { authorization: `Bearer ${TOKEN}` },
      data: { text: SAID, kind: "steer" },
    },
  );
  expect(message.status()).toBe(202);
  await expect(page.locator(".thread-browser-signin")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Hand back" })).toHaveCount(0);
  await expect
    .poll(async () => (await effects(page, fixture.origin)).join())
    .toContain('"movedOn":true');
});

test("the computer the user took themselves stays theirs on a phone until they hand it back", async ({
  page,
  ui,
}) => {
  test.skip(!isPhone(page), "A wide screen's field stays beside the computer");
  await ui.open("running");
  await page.getByRole("button", { name: "Take control" }).first().click();
  await expect(page.getByRole("button", { name: "Hand back" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Message dot" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Full screen", exact: true }).last()).toBeVisible();
});

test("every device sees the wait end, and its form can't be sent afterwards", async ({
  page,
  ui,
  browser,
}) => {
  const fixture = await ui.open("running");
  const { viewport, deviceScaleFactor, isMobile, hasTouch } = test.info().project.use;
  const other = await browser.newContext({ viewport, deviceScaleFactor, isMobile, hasTouch });
  try {
    const device = await other.newPage();
    await skipSetup(device);
    await chooseView(device, "studio");
    await device.goto(`${fixture.origin}/#token=${TOKEN}`);
    await expect(device.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await page.request.post(`${fixture.origin}/__qa/ask?fields=setup`);
    const form = device.locator("form.ask");
    await expect(form).toBeVisible();
    await form.getByRole("textbox", { name: "Project name", exact: true }).fill("Atlas");
    await expect(page.locator("form.ask")).toBeVisible();
    await send(page);
    await expect(form).toHaveCount(0);
    await expect(page.locator("form.ask")).toHaveCount(0);
    await expect(device.getByText("Not answered: you sent a message instead.")).toBeVisible();
    await expect(history(device).getByText(SAID)).toBeVisible();
    await expect(history(device).getByText(REPLY)).toBeVisible();
    expect((await effects(page, fixture.origin)).filter((e) => e.startsWith("ask:"))).toEqual([
      'ask:{"by":"message"}',
    ]);
    // The approval's card goes on the other device the same way.
    await page.request.post(`${fixture.origin}/__qa/approval?kind=send`);
    const approve = device.getByRole("button", { name: "Send", exact: true });
    await expect(approve).toBeVisible();
    await send(page, "Hold off on sending");
    await expect(approve).toBeHidden();
    await expect(device.getByRole("article", { name: "Not approved" })).toBeVisible();
  } finally {
    await other.close();
  }
});

test("a reload and a replay read a superseded question as not answered", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/ask`);
  await expect(page.locator("form.ask")).toBeVisible();
  await send(page);
  await dotReadIt(page);
  await page.request.post(`${fixture.origin}/__qa/approval?kind=send`);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await send(page, "Hold off on sending");
  await expect(page.getByRole("article", { name: "Not approved" })).toBeVisible();

  const reread = async () => {
    await expect(page.getByText("Which report format should I use?").first()).toBeVisible();
    await expect(page.getByText("Not answered: you sent a message instead.")).toBeVisible();
    await expect(page.getByRole("article", { name: "Not approved" })).toBeVisible();
    await expect(page.locator("form.ask")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  };
  await page.reload();
  await reread();
  // A finished task's own record, as Replay and a later task's history read it.
  await page.request.post(`${fixture.origin}/__qa/finish?done=1`);
  await page.reload();
  await reread();
  await ui.settle();
  await shot(page, "history");
  // The task's own Replay, from its record.
  ui.leaving();
  await page.goto(`${fixture.origin}/?replay=${fixture.sessionId}#token=${TOKEN}`);
  await expect(page.getByText("Not answered: you sent a message instead.").first()).toBeAttached();
  await expect(page.locator("form.ask")).toHaveCount(0);
  await shot(page, "replay");
});

test("a later task of the conversation reads the superseded question from its history", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/ask`);
  await expect(page.locator("form.ask")).toBeVisible();
  await send(page);
  await dotReadIt(page);
  await page.request.post(`${fixture.origin}/__qa/finish?done=1`);
  await expect(page.getByRole("region", { name: "Task result" })).toBeVisible();
  const card = await composer(page);
  await card.getByRole("textbox", { name: /^(New task|Message)$/ }).fill("Now do the next thing");
  await card.getByRole("button", { name: /^(Start task|Send|Send follow-up|Send now)$/ }).click();
  await expect(history(page).getByText("Now do the next thing")).toBeVisible();
  await page.reload();
  await expect(history(page).getByText("Now do the next thing")).toBeVisible();
  await expect(history(page).getByText("Not answered: you sent a message instead.")).toBeVisible();
  await shot(page, "later-task");
});

test("Your call. stays the foot's word for a question, and goes with it", async ({ page, ui }) => {
  test.skip(!isPhone(page), "The foot is a phone's");
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/ask`);
  await expect(page.locator("form.ask")).toBeVisible();
  await send(page);
  await dotReadIt(page);
  await expect(page.getByText("Your call.", { exact: true })).toHaveCount(0);
});

test.describe("in Chat", () => {
  test.use({ viewStyle: "chat" });

  for (const [name, path, gone] of [
    ["question", "/__qa/ask", ASK],
    ["approval", "/__qa/approval?kind=send", ".decision"],
  ] as const)
    test(`a message moves on from a ${name}, with the field where it always is`, async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("running");
      await page.request.post(`${fixture.origin}${path}`);
      await expect(page.locator(gone).first()).toBeVisible();
      const card = page.getByRole("form", { name: "Message dot" }).last();
      const box = card.getByRole("textbox", { name: "Message", exact: true });
      await expect(box).toHaveAttribute("placeholder", "Or message dot");
      await ui.settle();
      await shot(page, `chat-${name}-waiting`);
      await box.fill(SAID);
      await card.getByRole("button", { name: "Send now" }).click();
      await expect(page.locator(gone)).toHaveCount(0);
      await dotReadIt(page);
      await ui.settle();
      await shot(page, `chat-${name}-moved-on`);
    });

  test("a message ends dot's hand-over with the field in Chat", async ({ page, ui }) => {
    const fixture = await ui.open("running");
    await page.request.post(`${fixture.origin}/__qa/takeover`);
    const card = page.getByRole("form", { name: "Message dot" }).last();
    const box = card.getByRole("textbox", { name: "Message", exact: true });
    await expect(box).toHaveAttribute("placeholder", "Or message dot");
    await ui.settle();
    await shot(page, "chat-handover-waiting");
    await box.fill(SAID);
    await card.getByRole("button", { name: "Send now" }).click();
    await expect
      .poll(async () => (await effects(page, fixture.origin)).join())
      .toContain('"movedOn":true');
    await expect(page.getByText(REPLY).last()).toBeAttached();
    await ui.settle();
    await shot(page, "chat-handover-moved-on");
  });
});
