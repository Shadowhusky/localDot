import type { Page } from "@playwright/test";
import { nestedKeys } from "../settings-ui.ts";
import { expect, type Harness, isPhone, runAt, test } from "./harness.ts";

// Saved logins in Keys, the import's summary and the sign-in panel while the user holds the web
// browser, at both widths and in both colour modes. The shots are for looking at (no baselines).
runAt("c14", "c39", "w14", "w39");

const PASSWORD = "export-password-canary";
const EXPORT = `name,url,username,password\nAcme,https://acme.example.com/login,henry,${PASSWORD}\nGitHub,https://github.com,henry,${PASSWORD}\nNo password,https://empty.example.com,henry,\n`;

for (const scheme of ["light", "dark"] as const)
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(
        (choice) => localStorage.setItem("localdot.appearance.v1", choice),
        scheme === "light" ? "daylight" : "graphite",
      );
    });
    const shot = (page: Page, name: string) =>
      page.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`) });

    async function keys(page: Page, ui: Harness) {
      const fixture = await ui.open("ready");
      expect((await page.request.post(`${fixture.origin}/__qa/logins`)).ok()).toBe(true);
      await ui.picture();
      if (isPhone(page)) {
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.getByRole("menuitem", { name: "Keys", exact: true }).click();
      } else await page.getByTestId("keys-button").click();
      const sheet = nestedKeys(page);
      await expect(sheet.getByRole("heading", { name: "Saved logins" })).toBeVisible();
      return sheet;
    }

    test("lists, adds, edits and removes a login, with no way to read a password back", async ({
      page,
      ui,
    }) => {
      const sheet = await keys(page, ui);
      const heading = sheet.getByRole("heading", { name: "Saved logins" });
      await heading.scrollIntoViewIfNeeded();
      const list = sheet.getByRole("list", { name: "Saved logins" });
      await expect(list.getByText("github.com")).toBeVisible();
      await shot(page, "list");
      await sheet.getByRole("button", { name: "Add login" }).click();
      const form = sheet.getByRole("form", { name: "Add a login" });
      await form.getByRole("textbox", { name: "Site" }).fill("https://Acme.example.com/login");
      await form.getByRole("textbox", { name: "Account" }).fill("henry");
      await form.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
      await expect(form).toBeInViewport();
      await shot(page, "add");
      await form.getByRole("button", { name: "Save login" }).click();
      await expect(list.getByText("acme.example.com")).toBeVisible();
      await expect(form).toBeHidden();
      await expect(page.locator("body")).not.toContainText(PASSWORD);

      await sheet.getByRole("button", { name: "Edit login for acme.example.com" }).click();
      const edit = sheet.getByRole("form", { name: "Edit login for acme.example.com" });
      await expect(edit.getByRole("textbox", { name: "New password" })).toHaveValue("");
      await expect(edit.getByRole("textbox", { name: "Site" })).not.toBeEditable();
      await shot(page, "edit");
      await edit.getByRole("textbox", { name: "Account" }).fill("henry2");
      await edit.getByRole("button", { name: "Save login" }).click();
      await expect(list.getByText("henry2")).toBeVisible();

      await sheet.getByRole("button", { name: "Remove login for acme.example.com" }).click();
      await sheet
        .getByRole("button", { name: "Confirm remove login for acme.example.com" })
        .click();
      await expect(list.getByText("acme.example.com")).toBeHidden();
    });

    test("imports an export sealed in the page, and says to delete the file", async ({
      page,
      ui,
    }) => {
      const sent: string[] = [];
      page.on("request", (request) => sent.push(request.postData() ?? ""));
      const sheet = await keys(page, ui);
      await expect(sheet.getByText(/delete it afterwards/)).toBeVisible();
      await sheet.getByRole("heading", { name: "Saved logins" }).scrollIntoViewIfNeeded();
      await sheet.locator("input[type=file]").setInputFiles({
        name: "passwords.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(EXPORT),
      });
      const summary = sheet.locator(".saved-logins-summary");
      await expect(summary).toContainText("Imported 1 login.");
      await expect(summary).toContainText("1 site has a saved login already");
      await expect(summary).toContainText("1 row left out: no password (line 4)");
      await expect(summary).toContainText("Delete the file now.");
      await expect(sheet.getByRole("list", { name: "Saved logins" })).toContainText(
        "acme.example.com",
      );
      await summary.scrollIntoViewIfNeeded();
      await shot(page, "import");
      expect(sent.some((body) => body.includes("sealed"))).toBe(true);
      for (const body of sent) expect(body).not.toContain(PASSWORD);
      await expect(page.locator("body")).not.toContainText(PASSWORD);
    });

    test("offers the one tap in the conversation", async ({ page, ui }) => {
      const fixture = await ui.open("running");
      expect((await page.request.post(`${fixture.origin}/__qa/ask?fields=saved-login`)).ok()).toBe(
        true,
      );
      await expect(
        page
          .getByRole("button", { name: "Sign in", exact: true })
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      await expect(
        page
          .getByRole("button", { name: "Not now", exact: true })
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      await ui.settle();
      await shot(page, "tap");
    });

    test("offers a saved login, passkey wording and sign-in mode while the user holds the browser", async ({
      page,
      ui,
    }) => {
      let reply: unknown = {
        available: true,
        mode: "standard",
        changing: false,
        page: { saved: { site: "github.com", username: "henry@example.com" } },
      };
      await page.route("**/takeover/sign-in", (route) =>
        route.fulfill({
          status: 200,
          json: reply,
          headers: { "content-type": "application/json" },
        }),
      );
      const fixture = await ui.open("conversations");
      await ui.step("takeover");
      await expect(page.getByTestId("hud-status")).toHaveText("You're in control");
      expect((await page.request.post(`${fixture.origin}/__qa/screen?to=browser`)).ok()).toBe(true);
      const panel = page.locator(".thread-browser-signin");
      await expect(panel).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "Sign in as henry@example.com" }),
      ).toBeVisible();
      await expect(panel).toContainText("Passkeys and security keys can't work");
      await panel.scrollIntoViewIfNeeded();
      await shot(page, "hold-saved");
      reply = { available: true, mode: "signin", changing: false };
      await panel.getByRole("button", { name: "Sign in without agent control" }).click();
      await expect(panel).toContainText("Sign-in mode is on");
      await expect(panel).toContainText("Saved logins can't be filled here");
      await shot(page, "hold-signin-mode");
    });
  });
