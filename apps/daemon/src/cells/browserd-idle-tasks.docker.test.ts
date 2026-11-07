import { ulid } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserActionPermit } from "../../../../packages/protocol/src/browser-control.ts";
import { evalCellOptions } from "../agent/evals/cell.ts";
import { BrowserIdlePages, type IdleTask } from "../browser/idle-pages.ts";
import { bandShare, CELL_SITE, sleep, TestBrowserCell } from "./testing/browser-cell.ts";
import { DOCKER_TESTS } from "./testing/docker-cli.ts";

// The daemon's own freezing policy against a real browser cell, as on Nov 7: nobody watches, a
// conversation's earlier task left its page long ago, and a new task that continues it comes to the
// browser and navigates, then does so again after the browser is started anew. The policy runs on
// a short grace and sweep so the test takes minutes, not hours.
const scope = DOCKER_TESTS ? evalCellOptions() : undefined;
const GRACE_MS = 4000;
const SWEEP_MS = 1000;

describe.skipIf(!DOCKER_TESTS)("the idle-page policy and a task coming back", () => {
  let cell: TestBrowserCell;
  let policy: BrowserIdlePages;
  let tasks: IdleTask[] = [];
  const older = ulid();
  const task = ulid();
  let permit: BrowserActionPermit;
  let tab = "";
  const measured: Record<string, number | string> = {};

  const set = (next: IdleTask[]) => {
    tasks = next;
    policy.changed(cell.identity.parentCellId);
  };
  const working = () => set([{ id: task, busy: true, controlled: false }]);
  const resting = () => set([{ id: task, busy: false, controlled: false }]);
  // The page's own calls home: none while it is frozen.
  const calls = async (page: string, ms = 2000) => (await cell.beating(ms))(page);
  const frozen = async (page: string) => {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; )
      if ((await calls(page)) === 0) return true;
    return false;
  };
  // While the task is at work, every sweep keeps its window awake.
  const awakeThroughout = async (page: string) => {
    for (let look = 0; look < 4; look++) expect(await calls(page)).toBeGreaterThan(4);
  };
  const shown = async () => {
    const look = await cell.settled(() => cell.client.observe(permit, tab, cell.owner));
    return bandShare(Buffer.from(look.frame.image, "base64"));
  };

  beforeAll(async () => {
    if (!scope) return;
    cell = await TestBrowserCell.open({
      names: {
        network: `${scope.namePrefix}idle-net`,
        gate: `${scope.namePrefix}idle-gate`,
        browser: `${scope.namePrefix}idle-browser`,
      },
      subnet: "10.233.60",
      label: scope.label,
    });
    policy = new BrowserIdlePages({
      browsers: () => [
        { parentCellId: cell.identity.parentCellId, instance: cell.identity.instance },
      ],
      viewers: () => 0,
      tasks: () => tasks,
      send: async (_parent, instance, request) => {
        if (instance !== cell.identity.instance) throw new Error("the web browser changed");
        await cell.lifecycle(request);
      },
      graceMs: GRACE_MS,
      sweepMs: SWEEP_MS,
    });
  }, 600_000);

  afterAll(() => {
    policy?.dispose();
    if (!cell) return;
    console.log(cell.logs());
    cell.close();
    console.log("measured", JSON.stringify(measured));
  });

  it("lets a task that continues an older one navigate in the window that froze meanwhile", async () => {
    const { client, owner } = cell;
    // The conversation's earlier task left its page in the browser and ended.
    const earlier = await cell.grant(older);
    const left = (await client.enterWindow(earlier, { fresh: true }, owner)).tabs[0]?.id ?? "";
    await cell.settled(() => client.clock(earlier, left, owner));
    await client.navigate(earlier, left, `${CELL_SITE}/older`, owner);
    expect((await cell.running(earlier, left)).frames).toBeGreaterThan(10);
    await cell.release(earlier);
    set([]);
    expect(await frozen("/older")).toBe(true);
    await sleep(3 * GRACE_MS);

    // The new task is at work: it comes to the browser, in the window of the task it continues.
    working();
    permit = await cell.grant(task);
    const entered = await client.enterWindow(permit, { continues: older }, owner);
    expect(entered.opened).toBe(false);
    tab = entered.tabs[0]?.id ?? "";
    expect(tab).toBe(left);
    await client.navigate(permit, tab, `${CELL_SITE}/new`, owner);
    const page = await cell.running(permit, tab);
    expect(page).toMatchObject({ url: `${CELL_SITE}/new`, visible: "visible" });
    expect(page.frames).toBeGreaterThan(10);
    measured.continuedBand = await shown();
    expect(measured.continuedBand).toBeGreaterThan(0.1);
    await awakeThroughout("/new");
  });

  it("lets a navigate be the first thing a task does once its window froze", async () => {
    const { client, owner } = cell;
    resting();
    expect(await frozen("/new")).toBe(true);
    working();
    await client.navigate(permit, tab, `${CELL_SITE}/first`, owner);
    const page = await cell.running(permit, tab);
    expect(page).toMatchObject({ url: `${CELL_SITE}/first`, visible: "visible" });
    expect(page.frames).toBeGreaterThan(10);
    measured.firstBand = await shown();
    expect(measured.firstBand).toBeGreaterThan(0.1);
    await awakeThroughout("/first");
  });

  it("does the same in a browser started anew, which nothing freezes under a working task", async () => {
    const { owner } = cell;
    await cell.restart();
    policy.changed(cell.identity.parentCellId);
    const { client } = cell;
    permit = await cell.grant(task);
    const entered = await client.enterWindow(permit, { continues: older }, owner);
    tab = entered.tabs[0]?.id ?? "";
    await cell.settled(() => client.clock(permit, tab, owner));
    await client.navigate(permit, tab, `${CELL_SITE}/again`, owner);
    const page = await cell.running(permit, tab);
    expect(page).toMatchObject({ url: `${CELL_SITE}/again`, visible: "visible" });
    await awakeThroughout("/again");

    resting();
    expect(await frozen("/again")).toBe(true);
    working();
    await client.navigate(permit, tab, `${CELL_SITE}/later`, owner);
    expect(await cell.running(permit, tab)).toMatchObject({
      url: `${CELL_SITE}/later`,
      visible: "visible",
    });
    expect((await cell.supervisor()).restarts).toBe(0);
  });

  // What failed on Nov 7, and on Nov 5 and 6 before any page froze: web.telegram.org sends itself
  // on to /k/ by script as it commits, and a challenge page reloads itself.
  it("follows a page that moves on by itself, without restarting the browser", async () => {
    const { client, owner } = cell;
    await client.navigate(permit, tab, `${CELL_SITE}/hop`, owner);
    expect((await cell.running(permit, tab)).url).toBe(`${CELL_SITE}/landed`);
    await client.navigate(permit, tab, `${CELL_SITE}/reload-once`, owner);
    expect((await cell.running(permit, tab)).url).toBe(`${CELL_SITE}/checked`);
    expect((await cell.supervisor()).restarts).toBe(0);
  });
});
