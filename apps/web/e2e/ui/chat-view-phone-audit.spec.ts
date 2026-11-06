import { expect, finger, openComputerScreen, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test.use({ viewStyle: "chat" });

test.describe("a paused computer", () => {
  test.use({ phoneList: true });

  test("offers Resume on the list, in the conversation and on its screen", async ({ page, ui }) => {
    await ui.open("paused");
    const resume = page.locator(".phone-notice").getByRole("button", { name: "Resume" });
    await expect(resume).toBeVisible();
    await page.locator(".phone-row").first().click();
    await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "1");
    await expect(page.locator(".phone-chat").getByRole("button", { name: "Resume" })).toBeVisible();
    await openComputerScreen(page);
    const controls = page.locator(".phone-computer-controls");
    await expect(controls.getByRole("button", { name: "Shut down" })).toBeVisible();
    await controls.getByRole("button", { name: "Resume" }).click();
    await expect(controls.getByRole("button", { name: "Take control" })).toBeVisible();
    await expect(controls.getByRole("button", { name: "Resume" })).toBeHidden();
  });
});

test.describe("the list", () => {
  test.use({ phoneList: true });

  test("a search with no match keeps the page's margin", async ({ page, ui }) => {
    await ui.open("conversations");
    await page.getByRole("textbox", { name: "Search conversations" }).fill("zzzzq");
    const empty = page.locator(".phone-list-body > .ui-empty");
    await expect(empty).toContainText("No conversations match");
    const art = await empty.locator(".ui-empty-art").boundingBox();
    const search = await page.locator(".phone-search").boundingBox();
    expect(art?.x).toBe(search?.x);
  });

  test("the computer pill reaches a finger", async ({ page, ui }) => {
    await ui.open("conversations");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const pill = await page.locator(".phone-pill").boundingBox();
    if (!pill) throw new Error("no pill");
    const reached = await page.evaluate(
      ({ x, top, bottom }) =>
        [top, bottom].every((y) => document.elementFromPoint(x, y)?.closest(".phone-pill")),
      { x: pill.x + pill.width / 2, top: pill.y - 3, bottom: pill.y + pill.height + 3 },
    );
    expect(reached).toBe(true);
  });

  test("a new conversation's suggestions reach a finger", async ({ page, ui }) => {
    await ui.open("ready");
    await page.getByRole("button", { name: "New conversation" }).first().click();
    const chips = page.locator(".thread-suggestions .ui-chip");
    await expect(chips.first()).toBeVisible();
    const tall = await chips.evaluateAll((all) =>
      all.map((chip, index) => {
        const box = chip.getBoundingClientRect();
        const x = box.left + box.width / 2;
        return (
          document.elementFromPoint(x, box.top - 2)?.closest(".ui-chip") === chip &&
          (index === all.length - 1 ||
            !!document.elementFromPoint(x, box.bottom + 3)?.closest(".ui-chip"))
        );
      }),
    );
    expect(tall).not.toContain(false);
  });

  test("a row's rule lies under it, none over the first", async ({ page, ui }) => {
    await ui.open("conversations");
    const first = page.locator(".phone-row").first();
    await expect(first).toBeVisible();
    const rule = await first.evaluate((row) => {
      const { top, height } = getComputedStyle(row, "::after");
      return (
        Number.parseFloat(top) + Number.parseFloat(height) - row.getBoundingClientRect().height
      );
    });
    expect(Math.abs(rule)).toBeLessThanOrEqual(2);
  });

  test("one row rests open at a time, and a press elsewhere closes it", async ({ page, ui }) => {
    await ui.open("conversations");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const hand = await finger(page);
    const rows = page.locator(".phone-row-wrap");
    const open = page.locator(".ui-swipe[data-moved]");
    await hand.swipe(rows.nth(1), -0.35);
    await expect(open).toHaveCount(1);
    await hand.swipe(rows.nth(3), -0.35);
    await expect(rows.nth(3).locator(".ui-swipe[data-moved]")).toHaveCount(1);
    await expect(open).toHaveCount(1);
    await page.getByRole("heading", { name: "Conversations" }).tap();
    await expect(open).toHaveCount(0);
  });

  test("Replay's library goes back to Conversations, not a Studio word", async ({ page, ui }) => {
    await ui.open("conversations");
    await page.locator(".phone-pill").click();
    await page.getByRole("menuitem", { name: "Replay", exact: true }).click();
    await expect(page.getByRole("button", { name: "Conversations", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Watch", exact: true })).toHaveCount(0);
  });

  test("a value gives way before a short label in a narrow Settings row", async ({ page, ui }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await ui.open("conversations");
    await page.locator(".phone-pill").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    const label = page.locator(".ui-group-row-label", { hasText: "Models" });
    await expect(label).toBeVisible();
    const cut = await label.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(cut).toBe(false);
  });
});

test.describe("setup", () => {
  for (const width of [320, 390, 430])
    test(`a phone of ${width} can always put it off`, async ({ page, ui }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.addInitScript(() => localStorage.removeItem("localdot.onboarding.v1"));
      await page.addInitScript(() => {
        localStorage.setItem(
          "localdot.onboarding.v1",
          JSON.stringify({ step: "welcome", dismissed: false }),
        );
      });
      await ui.open("first-run");
      const later = page.getByRole("button", { name: "Later", exact: true });
      await expect(later).toBeInViewport({ ratio: 1 });
      await page.getByRole("button", { name: "Get started" }).click();
      await expect(page.getByRole("heading", { name: "How should dot think?" })).toBeVisible();
      await expect(later).toBeInViewport({ ratio: 1 });
      const bars = await page
        .locator(".onboarding-bar-step")
        .evaluateAll((all) => all.map((bar) => bar.getBoundingClientRect().right));
      expect(Math.max(...bars)).toBeLessThanOrEqual((await later.boundingBox())?.x ?? 0);
    });
});

test.describe("a conversation", () => {
  test("Back from a sheet leaves no sheet over the list", async ({ page, ui }) => {
    await ui.open("narrated");
    await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "1");
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Workspace", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Workspace" });
    await expect(sheet).toBeVisible();
    await page.goBack();
    await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "0");
    await expect(sheet).toBeHidden();
  });

  test("a chip reaches a finger, whichever chips it is", async ({ page, ui }) => {
    await ui.open("ask");
    const answers = page.locator(".ask-quick .ui-chip");
    await expect(answers.first()).toBeVisible();
    const reach = (selector: string) =>
      page.locator(selector).evaluateAll((chips) =>
        chips.map((chip) => {
          const box = chip.getBoundingClientRect();
          const x = box.left + box.width / 2;
          return [box.top - 2, box.bottom + 2].every((y) =>
            document.elementFromPoint(x, y)?.closest(".ui-chip"),
          );
        }),
      );
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    await expect.poll(() => reach(".ask-quick .ui-chip")).not.toContain(false);
  });

  test("a fenced computer's notice leads to Replace computer, not a held Try again", async ({
    page,
    ui,
  }) => {
    await ui.open("conversations");
    await ui.step("fenced");
    await page.goBack().catch(() => {});
    await page.evaluate(() => {
      window.location.hash = "";
    });
    const notice = page.locator(".phone-notice").first();
    await expect(notice).toContainText("fresh start");
    await expect(notice.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await notice.getByRole("button", { name: "Details" }).click();
    await expect(
      page.locator(".phone-computer-curtain").getByRole("button", { name: "Replace computer" }),
    ).toBeVisible();
  });

  test("the computer's steer box keeps its microphone, Stop being among the controls", async ({
    page,
    ui,
  }) => {
    await ui.open("running");
    await openComputerScreen(page);
    await expect(page.getByTestId("hud-stop-session")).toBeVisible();
    const dock = page.locator(".phone-computer-dock");
    await expect(dock.getByRole("button", { name: "Stop task" })).toBeHidden();
    await expect(dock.locator(".voice-mic")).toBeVisible();
  });

  test("the whole thumbnail opens the computer", async ({ page, ui }) => {
    await ui.open("running");
    const thumb = page.locator(".phone-thumb");
    await expect(thumb).toBeVisible();
    const box = await thumb.boundingBox();
    if (!box) throw new Error("no thumbnail");
    const strays = await page.evaluate(({ x, y, width, height }) => {
      const found: string[] = [];
      for (let across = 8; across < width - 8; across += 4)
        for (let down = 8; down < height - 8; down += 4) {
          const at = document.elementFromPoint(x + across, y + down);
          if (!at?.closest(".phone-thumb")?.matches("button") || at.closest(".phone-picture"))
            found.push(at?.className.toString() ?? "nothing");
        }
      return [...new Set(found)];
    }, box);
    expect(strays).toEqual([]);
  });

  test("the thumbnail's rim and picture round with its corners", async ({ page, ui }) => {
    await ui.open("running");
    const thumb = page.locator(".phone-thumb");
    await expect(thumb).toBeVisible();
    const corners = await thumb.evaluate((element) => {
      const radius = (selector: string) =>
        getComputedStyle(element.querySelector(selector) ?? element).borderTopLeftRadius;
      return {
        thumb: getComputedStyle(element).borderTopLeftRadius,
        rim: radius(".phone-thumb-rim"),
        slot: radius(".phone-thumb-slot"),
        clip: getComputedStyle(element.querySelector(".phone-thumb-slot") ?? element).clipPath,
      };
    });
    expect(corners.thumb).not.toBe("0px");
    expect(corners.rim).toBe(corners.thumb);
    expect(corners.slot).toBe(corners.thumb);
    expect(corners.clip).toContain("round");
    await ui.settle();
    const box = await thumb.boundingBox();
    if (box)
      await page.screenshot({
        path: test.info().outputPath("thumb.png"),
        clip: { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 },
        scale: "device",
      });
  });

  test("the way to the latest keeps clear of dot's line", async ({ page, ui }) => {
    const fixture = await ui.open("running");
    await page.request.post(`${fixture.origin}/__qa/talk?turns=6`);
    await page.locator(".phone-thread .thread-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    const jump = page.locator(".thread-jump[data-shown]");
    await expect(jump).toBeVisible();
    await expect
      .poll(async () => {
        const pill = await jump.boundingBox();
        const line = await page.locator(".dot-strip-row").boundingBox();
        return (pill?.y ?? 0) + (pill?.height ?? 0) - (line?.y ?? 0);
      })
      .toBeLessThanOrEqual(0);
  });

  test("Chat reads a step as dot's sentence, with what it did in its unfold", async ({
    page,
    ui,
  }) => {
    await ui.open("narrated");
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Workspace", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Workspace" });
    const row = sheet.locator(".activity-row", { hasText: "Adding up the net total" });
    await expect(row).toBeVisible();
    await expect(row.locator(".activity-row-meta")).toHaveCount(0);
    await row.locator(".activity-row-head").click();
    await expect(row.locator(".activity-detail-action")).toContainText("=SUM(F2:F13)");
    // A failure still says what went wrong.
    await expect(
      sheet
        .locator(".activity-row", { hasText: "Validate report schema" })
        .locator(".activity-row-meta"),
    ).toContainText("exit code 2");
    // A file's row keeps its words.
    await sheet.getByRole("tab", { name: /^Files/ }).click();
    await expect(sheet.locator(".activity-row-meta", { hasText: "Created" })).toBeVisible();
  });

  test("Workspace and Replay name the model, not its ID", async ({ page, ui }) => {
    await ui.open("narrated");
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Replay", exact: true }).click();
    await expect(page.getByText("Claude Sonnet 5.5").first()).toBeVisible();
    await expect(page.getByText("claude-sonnet-5-5")).toHaveCount(0);
  });
});

test("a phone on its side keeps Take control clear of the picture", async ({ page, ui }) => {
  await ui.open("running");
  await openComputerScreen(page);
  await page.setViewportSize({ width: 844, height: 390 });
  const take = page
    .locator(".phone-computer-controls")
    .getByRole("button", { name: "Take control" });
  await expect(take).toBeVisible();
  await expect
    .poll(async () => {
      const button = await take.boundingBox();
      const picture = await page.locator(".phone-picture").boundingBox();
      return (button?.x ?? 0) - ((picture?.x ?? 0) + (picture?.width ?? 0));
    })
    .toBeGreaterThanOrEqual(0);
  await take.click();
  await expect(page.getByRole("button", { name: "Hand back" })).toBeVisible();
  const toolbar = page.getByRole("toolbar", { name: "Computer controls" });
  const under = await toolbar.getByRole("button").evaluateAll((tools) =>
    tools.flatMap((tool) => {
      const box = tool.getBoundingClientRect();
      const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return tool.contains(at) ? [] : [tool.getAttribute("aria-label") ?? tool.textContent];
    }),
  );
  expect(under).toEqual([]);
});

test("a notched phone on its side keeps the picture tall and clear of what is beside it", async ({
  page,
  ui,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Safe areas are emulated through Chromium's DevTools");
  await ui.open("running");
  await openComputerScreen(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: 0, right: 47, bottom: 21, left: 47 },
  });
  await page.setViewportSize({ width: 844, height: 390 });
  const take = page
    .locator(".phone-computer-controls")
    .getByRole("button", { name: "Take control" });
  await expect(take).toBeVisible();
  const picture = page.locator(".phone-picture");
  await expect.poll(async () => (await picture.boundingBox())?.height ?? 0).toBeGreaterThan(320);
  const box = await picture.boundingBox();
  const back = await page.getByRole("button", { name: "Back to the conversation" }).boundingBox();
  expect(box?.x ?? 0).toBeGreaterThanOrEqual((back?.x ?? 0) + (back?.width ?? 0));
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual((await take.boundingBox())?.x ?? 0);
});
