import { expect, type Page, test } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "../fixtures/start-ui-fixture.ts";
import { FIXTURE_START } from "./harness.ts";

// The full preview of a page and an SVG dot made: their scripts never run (inline, handlers,
// javascript: links, a meta refresh), nothing they ask for leaves the Mac, and the frame holds only
// the task's own files. Requests are watched, not intercepted, so timing stays real; a request to the
// web counts when it got a response or failed for any reason but the page's policy.
const AT = ["c14", "w39"];
// Blocking service workers injects a probe into every frame, which throws inside the sandboxed one.
test.use({ serviceWorkers: "allow" });
test.beforeEach(() => {
  test.skip(!AT.includes(test.info().project.name), `Runs at ${AT.join(" and ")}`);
});

function watch(page: Page, fixture: UiFixture) {
  const left: string[] = [];
  const all: string[] = [];
  const errors: string[] = [];
  const outside = (url: string) => /^https?:/.test(url) && !url.startsWith(fixture.origin);
  page.on("request", (request) => all.push(request.url()));
  page.on("response", (response) => {
    if (outside(response.url())) left.push(response.url());
  });
  page.on("requestfailed", (request) => {
    const why = request.failure()?.errorText ?? "";
    if (outside(request.url()) && !/csp|content security policy|blocked|cancel/i.test(why))
      left.push(`${request.url()} (${why})`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => {
    errors.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return { left, all, errors };
}

test("a page and an SVG preview inert, with nothing leaving the Mac", async ({ page }) => {
  const fixture = await startUiFixture(
    { QA_SCENARIO: "running", QA_NOW: FIXTURE_START },
    "ui-previews",
  );
  try {
    const seen = watch(page, fixture);
    const handed = await page.request.post(`${fixture.origin}/__qa/previews`);
    expect(handed.ok(), await handed.text()).toBe(true);
    await page.goto(`${fixture.origin}/#token=${TOKEN}`);
    const card = page.getByRole("region", { name: "Task result" }).last();
    await card.getByRole("button", { name: "Open summary.html", exact: true }).click();

    const frame = page.locator("iframe.viewer-frame");
    await expect(frame).toHaveAttribute("sandbox", "");
    const src = (await frame.getAttribute("src")) ?? "";
    expect(src).toMatch(/\/file-previews\/[\w-]{43}\/summary\.html\?v=1$/);
    const served = await page.request.get(src);
    const policy = served.headers()["content-security-policy"] ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("sandbox");
    expect(policy).not.toContain("script-src");

    // The page draws with its own stylesheet and picture, and says what it left out.
    const content = page.frameLocator("iframe.viewer-frame");
    await expect(content.getByRole("heading", { name: "Quarter in brief" })).toBeVisible();
    await expect
      .poll(() =>
        content
          .getByRole("img", { name: "Net by month" })
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(page.getByText("Pictures from the web are not loaded")).toBeVisible();

    // A javascript: link and a form do nothing; the meta refresh never fires.
    await content.getByRole("link", { name: "Open the dashboard" }).click();
    await content.getByRole("button", { name: "Send feedback" }).click();
    await page.waitForTimeout(1600);
    expect(page.frames().some((f) => f.url().includes("summary.html"))).toBe(true);

    // An SVG with a script and an onload handler is drawn as a picture only.
    await page.getByRole("button", { name: "Next file" }).click();
    await page.getByRole("button", { name: "Next file" }).click();
    const svg = page.getByRole("img", { name: "diagram.svg" });
    await expect
      .poll(() => svg.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);

    // A link out of the page is stopped by localDot's own policy before it leaves.
    await page.getByRole("button", { name: "Previous file" }).click();
    await page.getByRole("button", { name: "Previous file" }).click();
    await content.getByRole("link", { name: "Full report" }).click();
    await page.waitForTimeout(1000);

    const state = (await (await page.request.get(`${fixture.origin}/__qa/state`)).json()) as {
      effects: string[];
    };
    expect(state.effects.filter((effect) => effect.startsWith("canary"))).toEqual([]);
    expect(seen.all.filter((url) => url.includes("/__qa/canary"))).toEqual([]);
    expect(seen.left).toEqual([]);
    expect(seen.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("the preview link reads only that task's own files", async ({ page }) => {
  const fixture = await startUiFixture(
    { QA_SCENARIO: "running", QA_NOW: FIXTURE_START },
    "ui-previews",
  );
  try {
    await page.request.post(`${fixture.origin}/__qa/previews`);
    const { sessionId } = (await (
      await page.request.get(`${fixture.origin}/__qa/state`)
    ).json()) as {
      sessionId: string;
    };
    const link = await page.request.post(
      `${fixture.origin}/api/agent/sessions/${sessionId}/preview-link`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const { base } = (await link.json()) as { base: string };
    expect((await page.request.get(`${fixture.origin}${base}chart.png`)).status()).toBe(200);
    for (const path of ["..%2F..%2Ftoken", "%2e%2e", ".chart.png", "totals.json", "chart.png?v=99"])
      expect(
        (await page.request.get(`${fixture.origin}${base}${path}`)).status(),
        path,
      ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await page.request.get(`${fixture.origin}/file-previews/${"A".repeat(43)}/chart.png`)
      ).status(),
    ).toBe(404);
  } finally {
    await fixture.close();
  }
});
