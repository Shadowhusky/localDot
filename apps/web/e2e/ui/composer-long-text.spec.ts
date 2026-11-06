import type { Locator, Page } from "@playwright/test";
import { attachFiles, finishUploads } from "./attach.ts";
import { composer, expect, isPhone, runAt, test } from "./harness.ts";

// What the composer takes: files with no words, and text of any length, which goes as a file.
runAt("c14", "c39", "w14", "w39");

async function paste(field: Locator, text: string) {
  await field.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

function sentMessages(page: Page) {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/messages$/.test(request.url()))
      sent.push(request.postDataJSON().text);
  });
  return sent;
}

const sendButton = (card: Locator) => card.locator(".composer-send");

test("files go with no words, to dot and in the thread", async ({ page, ui }) => {
  await ui.open("running");
  const sent = sentMessages(page);
  const card = await composer(page);
  await attachFiles(page, card, ["figures.csv"]);
  const send = sendButton(card);
  await expect(send).toHaveAccessibleName("Send now");
  await expect(send).toBeEnabled();
  await send.click();
  const row = page
    .getByRole("article", { name: "You", exact: true })
    .filter({ has: page.getByRole("list", { name: "Attached files" }) })
    .last();
  await expect(row.getByText("figures.csv")).toBeVisible();
  await expect(row.locator(".thread-bubble-text")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Copy your message" })).toHaveCount(0);
  expect(sent).toEqual([
    expect.stringMatching(/^\n\nAttached files on this computer:\n- .*figures\.csv$/),
  ]);
  await expect(card.getByRole("button", { name: "Stop task" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("files-only.png") });
});

test("a new task can start from files alone", async ({ page, ui }) => {
  await ui.open("ready");
  await finishUploads(page);
  const card = await composer(page);
  const started: { task: string }[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/agent$/.test(request.url()))
      started.push(request.postDataJSON());
  });
  await attachFiles(page, card, ["notes.txt"]);
  await sendButton(card).click();
  await expect(page.getByRole("article", { name: "You", exact: true }).last()).toContainText(
    "notes.txt",
  );
  expect(started[0]?.task).toMatch(/^\n\nAttached files on this computer:\n- .*notes\.txt$/);
});

test("a long paste becomes a chip that reads back, removes and sends", async ({ page, ui }) => {
  await ui.open("running");
  await finishUploads(page);
  const sent = sentMessages(page);
  const card = await composer(page);
  const field = card.getByRole("textbox").first();
  await field.click();
  await field.fill("Summarise this");
  const log = Array.from({ length: 1240 }, (_, n) => `line ${n} of the build`).join("\n");
  await paste(field, log);
  const chip = card.getByRole("button", { name: "Read Pasted text · 1,240 lines" });
  await expect(chip).toBeVisible();
  await expect(field).toHaveValue("Summarise this");
  await expect(field).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("chip.png") });

  await chip.click();
  const sheet = page.getByRole("dialog", { name: "Pasted text · 1,240 lines" });
  await expect(sheet).toContainText("line 1239 of the build");
  await page.screenshot({ path: test.info().outputPath("chip-sheet.png") });
  await sheet
    .getByRole("button", { name: "Done" })
    .or(sheet.getByRole("button", { name: "Close" }))
    .first()
    .click();
  await expect(sheet).toHaveCount(0);

  await card.getByRole("button", { name: /^Remove Pasted text/ }).click();
  await expect(chip).toHaveCount(0);
  await expect(field).toHaveValue("Summarise this");

  await paste(field, log);
  await expect(chip).toBeVisible();
  await expect(sendButton(card)).toBeEnabled();
  await sendButton(card).click();
  await expect(page.getByRole("article", { name: "You", exact: true }).last()).toContainText(
    "Summarise this",
  );
  expect(sent).toEqual([
    expect.stringMatching(
      /^Summarise this\n\nAttached files on this computer:\n- .*Pasted text .*\.txt$/,
    ),
  ]);
  await expect(field).toHaveValue("");
});

test("typing has no end, and a long message goes as a file", async ({ page, ui }) => {
  await ui.open("running");
  await finishUploads(page);
  const sent = sentMessages(page);
  const card = await composer(page);
  const field = card.getByRole("textbox").first();
  await field.click();
  expect(await field.getAttribute("maxlength")).toBeNull();
  // A message past the mark, which goes as a file as soon as it is sent.
  await field.fill("Long words ".repeat(600));
  await expect(sendButton(card)).toBeEnabled();
  await sendButton(card).click();
  await expect(field).toHaveValue("");
  await expect
    .poll(() => sent)
    .toEqual([
      expect.stringMatching(/^\n\nAttached files on this computer:\n- .*Long message .*\.txt$/),
    ]);
  await expect(card.getByRole("button", { name: "Read Long message · 1 line" })).toHaveCount(0);
  // Past what the key guard reads, the words so far carry on as a file and the field stays free.
  await field.fill("x ".repeat(4100));
  await expect(field).toHaveValue("");
  await expect(card.getByRole("button", { name: "Read Long message · 1 line" })).toBeVisible();
  await expect(field).toBeFocused();
  await expect(card.getByText("Message cleared")).toHaveCount(0);
  await page.keyboard.type("more");
  await expect(field).toHaveValue("more");
});

test("a long paste waits on a computer that isn't ready, and the draft stays", async ({
  page,
  ui,
}) => {
  await ui.open("off");
  const card = await composer(page);
  const field = card.getByRole("textbox").first();
  await field.click();
  await field.fill("My draft");
  await paste(field, "Long words ".repeat(800));
  await expect(card.getByRole("button", { name: "Read Pasted text · 1 line" })).toBeVisible();
  await expect(field).toHaveValue("My draft");
  await expect(card.getByText("Message cleared")).toHaveCount(0);
});

test("a key in a long paste comes out, and the rest still attaches", async ({ page, ui }) => {
  await ui.open("running");
  await finishUploads(page);
  const card = await composer(page);
  const field = card.getByRole("textbox").first();
  await field.click();
  const key = `sk-proj-${"z".repeat(80)}`;
  await paste(field, `${"Long words ".repeat(800)} ${key}`);
  await card.getByRole("button", { name: "Read Pasted text · 1 line" }).click();
  const sheet = page.getByRole("dialog", { name: "Pasted text · 1 line" });
  await expect(sheet).toContainText("Long words");
  await expect(sheet).not.toContainText(key);
  await sheet
    .getByRole("button", { name: "Done" })
    .or(sheet.getByRole("button", { name: "Close" }))
    .first()
    .click();
  await expect(card.getByText("Keys were taken out of the pasted text.")).toBeVisible();
});

test("the safeguard's notice stands evenly inside the card, clear of its top", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  const card = await composer(page);
  const field = card.getByRole("textbox").first();
  await field.click();
  // More keys than the guard can hold: it clears the message and says why.
  await field.fill(
    Array.from(
      { length: 17 },
      (_, n) => `sk-proj-${String(n).padStart(4, "0")}${"z".repeat(60)}`,
    ).join(" "),
  );
  await expect(card.getByText("Message cleared")).toBeVisible();
  await ui.settle();
  const banner = await card.locator(".composer-key .ui-banner").boundingBox();
  const box = await card.boundingBox();
  if (!banner || !box) throw new Error("Missing notice");
  await page.screenshot({ path: test.info().outputPath("message-cleared.png") });
  if (isPhone(page)) {
    // It floats over the thread at the toolbar's width, the same distance from each side.
    const width = page.viewportSize()?.width ?? 0;
    expect(Math.abs(banner.x - (width - banner.x - banner.width))).toBeLessThanOrEqual(1);
    expect(banner.x).toBeGreaterThanOrEqual(4);
    expect(banner.y + banner.height).toBeLessThanOrEqual(box.y - 4);
  } else {
    expect(banner.y - box.y).toBeGreaterThanOrEqual(7);
    expect(
      Math.abs(banner.x - box.x - (box.x + box.width - banner.x - banner.width)),
    ).toBeLessThanOrEqual(1);
    expect(banner.x - box.x).toBeGreaterThanOrEqual(7);
  }
});
