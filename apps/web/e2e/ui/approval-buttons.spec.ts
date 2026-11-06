import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
for (const kind of ["send", "delete"]) {
  test(`${kind} confirmation looks enabled and submits once`, async ({ page, ui }) => {
    const fixture = await ui.open("running");
    await page.request.post(`${fixture.origin}/__qa/approval?kind=${kind}`);
    const name = kind === "delete" ? "Delete" : "Send";
    const action = page.getByRole("button", { name, exact: true });
    await expect(action).toBeVisible();
    await expect(action).not.toHaveAttribute("aria-disabled", "true");
    await expect(action.locator(".ui-button-content")).toHaveCSS("opacity", "1");
    await expect
      .poll(() => action.evaluate((el) => getComputedStyle(el, "::before").opacity))
      .toBe("1");
    const face = await action.evaluate((el) => {
      const style = getComputedStyle(el, "::before");
      return { color: style.backgroundColor, image: style.backgroundImage };
    });
    expect(face.color !== "rgba(0, 0, 0, 0)" || face.image !== "none").toBe(true);
    if (kind === "delete") {
      await expect(action).toHaveAttribute("data-variant", "destructive");
      expect(face.color).toBe("rgb(240, 143, 143)");
    }
    await expect
      .poll(() =>
        action.evaluate((el) => {
          let opacity = 1;
          for (let parent: Element | null = el; parent; parent = parent.parentElement)
            opacity *= Number(getComputedStyle(parent).opacity);
          return opacity;
        }),
      )
      .toBe(1);
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath(`${kind}.png`) });
    const submitted = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith("/approvals/answer"),
    );
    await action.click();
    expect((await submitted).postDataJSON()).toMatchObject({ decision: "approve" });
    await expect(action).toBeHidden();
  });
}

// A phone's decision is a sheet over the stage. As the message field grows with what the user types,
// the sheet rises with it, so its answers are never under the field.
test("a phone's decision keeps its answers above the message field as it grows", async ({
  page,
  ui,
}) => {
  test.skip(!isPhone(page), "On a wide screen the decision sits in the conversation");
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/approval?kind=send`);
  const action = page.getByRole("button", { name: "Send", exact: true });
  await expect(action).toBeVisible();
  await page
    .getByRole("form", { name: "Message dot" })
    .last()
    .getByRole("textbox")
    .first()
    .fill("Wait, check the totals first\nthen the subject line\nand the attachment too");
  await expect
    .poll(async () => {
      const [answer, field] = await Promise.all([
        action.boundingBox(),
        page.locator(".thread-toolbar").boundingBox(),
      ]);
      return (answer?.y ?? 0) + (answer?.height ?? 0) - (field?.y ?? 0);
    })
    .toBeLessThanOrEqual(0);
});
