import { chatRail as conversation, expect, isPhone, runAt, test } from "./harness.ts";

// The conversation thread in each of its states.
runAt("c14", "w39");

test("thread, running", async ({ page, ui }) => {
  await ui.open("running");
  const rail = await conversation(page);
  await expect(rail.locator(".thread-live .thread-work")).toContainText(
    "Checking February's net total against revenue minus returns",
  );
  await ui.settle();
  await ui.still();
});

test("thread, done with files", async ({ page, ui }) => {
  await ui.open("done");
  const rail = await conversation(page);
  await expect(rail.getByRole("region", { name: "Task result" })).toContainText("totals.csv");
  await ui.settle();
  await ui.still();
});

test("thread, question", async ({ page, ui }) => {
  await ui.open("ask");
  const rail = await conversation(page);
  // In the thread beside a wide screen; a phone asks in a sheet, and its message field answers too.
  if (isPhone(page)) {
    await expect(
      page.getByRole("form", { name: "Which report format should I use?" }),
    ).toBeVisible();
    await expect(rail.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "placeholder",
      "Answer dot",
    );
  } else await expect(rail.getByRole("form", { name: "Answer dot" })).toBeVisible();
  await ui.settle();
  await ui.still();
});

test("thread, recovery", async ({ page, ui }) => {
  await ui.open("budget");
  const rail = await conversation(page);
  const recovery = rail.getByRole("region", { name: "Task recovery" });
  await expect(recovery.getByRole("button", { name: "Raise to $7 and continue" })).toBeVisible();
  await ui.settle();
  await ui.still();
});
