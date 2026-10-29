import type { PreviewOpened, PreviewRefusal, PreviewsStatus } from "@localdot/protocol";
import type { Page, Route } from "@playwright/test";
import { settingsSheet } from "../settings-ui.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

// Servers dot starts in its computer, opened on the owner's devices. The fixture has no computer, so
// the daemon's previews routes answer here; a tapped chip's new tab records where it was sent.
runAt("c14", "c39", "w39");

const HOST = "https://richards-mac-studio.tail849a6b.ts.net";
const VITE = "http://localhost:5173/";
const READY: PreviewsStatus = {
  state: "ready",
  addresses: ["172.20.0.11"],
  previews: [],
  servers: [],
};
const opened = (target: string, port: number): PreviewOpened => ({
  preview: { id: `p${port}`, target, origin: `${HOST}:${port}`, openedAt: "2026-10-08T09:00:30Z" },
  open: `${HOST}:${port}/__localdot/preview#secret-${port}`,
});

interface Daemon {
  status: PreviewsStatus;
  refusal?: { status: number; body: PreviewRefusal };
  requests: unknown[];
  stopped: string[];
  // The last port a new preview took.
  port: number;
}

async function previewsDaemon(page: Page, status: PreviewsStatus): Promise<Daemon> {
  const daemon: Daemon = { status, requests: [], stopped: [], port: 4900 };
  await page.route("**/api/sessions/*/previews", (route: Route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: daemon.status });
    const body = request.postDataJSON() as { url?: string; port?: number };
    daemon.requests.push(body);
    if (daemon.refusal)
      return route.fulfill({ status: daemon.refusal.status, json: daemon.refusal.body });
    const target = body.url ?? `http://localhost:${body.port}/`;
    // A server already open keeps its preview; the answer is a new link to it.
    const open = daemon.status.previews.find((preview) => preview.target === target);
    const answer = opened(target, open ? Number(new URL(open.origin).port) : ++daemon.port);
    if (!open)
      daemon.status = { ...daemon.status, previews: [...daemon.status.previews, answer.preview] };
    return route.fulfill({ json: answer });
  });
  await page.route("**/api/sessions/*/previews/*", (route: Route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    daemon.stopped.push(id);
    daemon.status = {
      ...daemon.status,
      previews: daemon.status.previews.filter((preview) => preview.id !== id),
    };
    return route.fulfill({ status: 204, body: "" });
  });
  return daemon;
}

// What a tap's new tab was sent to, and whether it could still reach the app that opened it.
async function recordTabs(page: Page) {
  await page.evaluate(() => {
    let opens = 0;
    window.open = () => {
      document.documentElement.dataset.tabsOpened = String(++opens);
      const tab = {
        opener: window as Window | null,
        closed: false,
        location: {
          replace(url: string) {
            document.documentElement.dataset.previewTab = url;
            document.documentElement.dataset.previewOpener = String(tab.opener !== null);
          },
        },
        close() {
          tab.closed = true;
          document.documentElement.dataset.previewClosed = "true";
        },
      };
      return tab as unknown as Window;
    };
  });
}

const html = (page: Page) => page.locator("html");

async function showActivity(page: Page) {
  if (isPhone(page)) await page.getByRole("button", { name: "Activity", exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: "Activity", exact: true }).click();
}

async function previewsTab(page: Page) {
  await showActivity(page);
  await page.getByRole("tab", { name: /^Previews/ }).click();
  return page.getByRole("tabpanel", { name: /Previews/ });
}

async function say(page: Page, origin: string, text: string) {
  const reply = await page.request.post(`${origin}/__qa/say?text=${encodeURIComponent(text)}`);
  expect(reply.ok()).toBe(true);
}

test("an address dot writes or a command prints opens as a preview in the tab the tap opened", async ({
  page,
  ui,
}) => {
  const daemon = await previewsDaemon(page, READY);
  const fixture = await ui.open("running");
  await recordTabs(page);
  await say(page, fixture.origin, `The shop runs at ${VITE} now, with hot reload.`);
  const message = page
    .locator(".thread-message[data-role='dot']")
    .filter({ hasText: "The shop runs" });
  const chip = message.getByRole("button", { name: "Open preview of localhost:5173" });
  await expect(chip).toBeVisible();
  // The address no longer leads to the device's own localhost.
  await expect(message.getByRole("link", { name: VITE })).toHaveCount(0);
  await expect(chip).toHaveAttribute("data-state", "ready");
  await chip.scrollIntoViewIfNeeded();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("chip-in-message.png") });
  await chip.click();
  await expect(html(page)).toHaveAttribute("data-preview-tab", opened(VITE, 4901).open);
  await expect(html(page)).toHaveAttribute("data-preview-opener", "false");
  expect(daemon.requests).toEqual([{ url: VITE }]);

  await page.request.post(`${fixture.origin}/__qa/work?kind=shell`);
  await page.request.post(
    `${fixture.origin}/__qa/work?kind=output&text=${encodeURIComponent(
      "  VITE v7.1.2  ready in 312 ms\n\n  ➜  Local:   http://localhost:4173/\n  ➜  Network: http://172.20.0.11:4173/\n",
    )}`,
  );
  await showActivity(page);
  const row = page
    .locator(".activity-rail")
    .getByTestId("tool-row")
    .filter({ hasText: "Check the project" })
    .last();
  await row.getByRole("button", { name: /Check the project/ }).click();
  const output = row.getByRole("region", { name: "Command output" });
  await expect(output).toContainText("Network: http://172.20.0.11:4173/");
  // Local and Network name one server, so it has one chip.
  const chips = output.getByRole("button", { name: /^Open preview of / });
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveAccessibleName("Open preview of localhost:4173");
  await chips.scrollIntoViewIfNeeded();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("chip-in-output.png") });
  await chips.click();
  await expect(html(page)).toHaveAttribute(
    "data-preview-tab",
    opened("http://localhost:4173/", 4902).open,
  );
  expect(daemon.requests).toEqual([{ url: VITE }, { url: "http://localhost:4173/" }]);
});

test("the Previews list opens and stops previews, and opens servers that never printed an address", async ({
  page,
  ui,
}) => {
  const daemon = await previewsDaemon(page, {
    ...READY,
    previews: [opened(VITE, 4900).preview],
    servers: [
      { port: 5173, url: VITE, name: "node" },
      { port: 8000, url: "http://localhost:8000/", name: "python3" },
    ],
  });
  await ui.open("running");
  await recordTabs(page);
  const panel = await previewsTab(page);
  const open = panel.getByRole("button", { name: "Open preview of localhost:5173" });
  await expect(open).toBeVisible();
  await expect(panel.getByText("python3")).toBeVisible();
  // A server already open as a preview is listed once, as the preview, named by its program.
  await expect(panel.getByText("node", { exact: true })).toHaveCount(1);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("previews-list.png") });

  await open.click();
  await expect(html(page)).toHaveAttribute("data-preview-tab", opened(VITE, 4900).open);
  await panel.getByRole("button", { name: "Open preview of localhost:8000" }).click();
  await expect(html(page)).toHaveAttribute(
    "data-preview-tab",
    opened("http://localhost:8000/", 4901).open,
  );
  // The server just opened moves from the servers to the open previews.
  await expect(panel.getByRole("button", { name: "Stop preview of localhost:8000" })).toBeVisible();
  expect(daemon.requests).toEqual([{ url: VITE }, { port: 8000 }]);

  await panel.getByRole("button", { name: "Stop preview of localhost:5173" }).click();
  await expect.poll(() => daemon.stopped).toEqual(["p4900"]);
  await expect(panel.getByRole("button", { name: "Stop preview of localhost:5173" })).toHaveCount(
    0,
  );
});

test("a computer without the preview service says to update it, and a chip opens no tab", async ({
  page,
  ui,
}) => {
  const message = "Update your computer to open the servers dot starts in it.";
  const daemon = await previewsDaemon(page, {
    ...READY,
    state: "needs-update",
    message,
    addresses: [],
  });
  const fixture = await ui.open("running");
  await recordTabs(page);
  const panel = await previewsTab(page);
  await expect(panel.getByText("Update your computer to open previews")).toBeVisible();
  await expect(panel.getByText(message)).toBeVisible();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("previews-update.png") });
  if (isPhone(page)) await page.getByRole("button", { name: "Done", exact: true }).click();
  else await page.locator(".rail-chat").getByRole("radio", { name: "Chat", exact: true }).click();

  await say(page, fixture.origin, `Started it: ${VITE}`);
  const chip = page.getByRole("button", { name: "Open preview of localhost:5173" });
  await expect(chip).toHaveAttribute("data-state", "needs-update");
  await chip.click();
  const notice = page.getByRole("dialog", { name: "Update your computer to open previews" });
  await expect(notice).toContainText(message);
  await expect(html(page)).not.toHaveAttribute("data-tabs-opened", /./);
  expect(daemon.requests).toEqual([]);
});

test("without Tailscale a chip says how to turn it on, opens no tab, and leads to Settings", async ({
  page,
  ui,
}) => {
  const message =
    "Previews open over Tailscale, so they work on your phone too. Turn it on in Settings → Your computer.";
  const daemon = await previewsDaemon(page, { ...READY, state: "needs-tailscale", message });
  const fixture = await ui.open("running");
  await recordTabs(page);
  await say(page, fixture.origin, `Try \`${VITE}\` once it's up.`);
  const chip = page.getByRole("button", { name: "Open preview of localhost:5173" });
  // The status arrives as the first chip shows; once it has, a tap explains instead of opening.
  await expect(chip).toHaveAttribute("data-state", "needs-tailscale");
  await chip.click();
  const notice = page.getByRole("dialog", { name: "Previews open over Tailscale" });
  await expect(notice).toContainText(message);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("previews-tailscale.png") });
  await expect(html(page)).not.toHaveAttribute("data-tabs-opened", /./);
  expect(daemon.requests).toEqual([]);
  await notice.getByRole("button", { name: "Open settings" }).click();
  // Settings opens at Your computer, where Tailscale is turned on.
  await expect(
    settingsSheet(page).getByRole("region", { name: "Your computer", exact: true }),
  ).toBeVisible();
  await expect(settingsSheet(page).getByRole("heading", { name: "App links" })).toBeInViewport();
});
