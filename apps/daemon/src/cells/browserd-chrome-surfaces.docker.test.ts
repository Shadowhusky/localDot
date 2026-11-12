import { ulid } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserActionPermit } from "../../../../packages/protocol/src/browser-control.ts";
import { evalCellOptions } from "../agent/evals/cell.ts";
import { CELL_SITE, sleep, TestBrowserCell } from "./testing/browser-cell.ts";
import { DOCKER_TESTS } from "./testing/docker-cli.ts";

// The browser's own dialogs and bubbles take the page from a task: browserd refuses every read and
// input while one is over it, and nothing here can answer one. On Nov 12 douyin.com, a page in
// Chinese that opens its desktop app as it loads, brought up "Translate this page?" (Google Chrome
// only) and "Open xdg-open?", and "login to douyin" ended with the browser called unresponsive.
const scope = DOCKER_TESTS ? evalCellOptions() : undefined;
// Both were up within a second and a half of the page.
const SURFACE_MS = 3000;

describe.skipIf(!DOCKER_TESTS)("pages that would bring up the browser's own surfaces", () => {
  let cell: TestBrowserCell;
  let permit: BrowserActionPermit;
  let tab = "";

  beforeAll(async () => {
    if (!scope) return;
    cell = await TestBrowserCell.open({
      names: {
        network: `${scope.namePrefix}surfaces-net`,
        gate: `${scope.namePrefix}surfaces-gate`,
        browser: `${scope.namePrefix}surfaces-browser`,
      },
      subnet: "10.233.61",
      label: scope.label,
    });
    permit = await cell.grant(ulid());
    tab = (await cell.client.enterWindow(permit, { fresh: true }, cell.owner)).tabs[0]?.id ?? "";
    await cell.settled(() => cell.client.clock(permit, tab, cell.owner));
  }, 600_000);

  afterAll(() => {
    if (!cell) return;
    console.log(cell.logs());
    cell.close();
  });

  it.each([
    ["a page in another language", "/zh", "欢迎来到这个页面"],
    ["a page that opens an app's link", "/app-link", "App link page"],
    ["a frame that opens an app's link", "/app-frame", "App frame page"],
  ])(
    "%s stays the task's to read and use",
    async (_what, path, heading) => {
      const { client, owner } = cell;
      await client.navigate(permit, tab, `${CELL_SITE}${path}`, owner);
      await sleep(SURFACE_MS);
      await cell.settled(() => client.clock(permit, tab, owner));
      const page = await cell.settled(() => client.read(permit, tab, { maxChars: 4000 }, owner));
      expect(page.url).toBe(`${CELL_SITE}${path}`);
      expect(page.text).toContain(heading);
      const look = await cell.settled(() => client.observe(permit, tab, owner));
      expect(look.frame.image.length).toBeGreaterThan(1000);
    },
    120_000,
  );

  // One the browser still brings up, as for a site that asks for a name and password: the task
  // hears that the browser's own surface is over the page, and a person who takes control closes it.
  it("says its own dialog covers a page, which is the task's again once a person closes it", async () => {
    const { client, owner } = cell;
    await client.navigate(permit, tab, `${CELL_SITE}/needs-sign-in`, owner);
    await sleep(SURFACE_MS);
    await expect(client.clock(permit, tab, owner)).rejects.toMatchObject({ code: "covered" });
    const { owner: task, ...identity } = permit;
    const person = { ...identity, requestId: ulid(), revision: permit.revision + 1 };
    await client.control({ ...person, holder: "user" }, owner);
    await client.manual(person, { kind: "key", combo: ["Escape"] }, owner);
    const again = { ...identity, owner: task, requestId: ulid(), revision: permit.revision + 2 };
    await client.control({ ...again, holder: "agent" }, owner);
    await cell.settled(() => client.clock(again, tab, owner));
    const page = await cell.settled(() => client.read(again, tab, { maxChars: 4000 }, owner));
    expect(page.text).toContain("Needs sign-in page");
  }, 120_000);
});
