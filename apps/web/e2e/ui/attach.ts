import { expect, type Locator, type Page } from "@playwright/test";

// Attaches files the computer takes at once, as finished uploads. Each event that changes the task
// makes the composer check it again, and until it has, it holds off Attach for a moment: a choice it
// turned down is made again.
export async function attachFiles(page: Page, card: Locator, names: string[]) {
  await page.route("**/api/cells/*/uploads", (route) => {
    const { id, name, bytes } = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: {
        id,
        name,
        bytes,
        offset: bytes,
        phase: "complete",
        sha256: "0".repeat(64),
        path: `~/Downloads/Uploads/${id}/${name}`,
      },
    });
  });
  const uploaded = card.getByText("Uploaded to Downloads");
  await expect(async () => {
    if (!(await uploaded.count())) {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 2000 }),
        card.getByRole("button", { name: "Attach files" }).click({ timeout: 2000 }),
      ]);
      await chooser.setFiles(
        names.map((name) => ({ name, mimeType: "text/plain", buffer: Buffer.from(name) })),
      );
    }
    await expect(uploaded).toHaveCount(names.length, { timeout: 2000 });
  }).toPass({ timeout: 60_000 });
}
