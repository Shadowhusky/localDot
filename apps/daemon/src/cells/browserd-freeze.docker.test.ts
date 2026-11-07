import { ulid } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_FREEZE_AFTER_USE_MS } from "../../../../cells/browser/browserd/src/windows.ts";
import type { BrowserActionPermit } from "../../../../packages/protocol/src/browser-control.ts";
import type { BrowserDownloadBinding } from "../../../../packages/protocol/src/browser-downloads.ts";
import { evalCellOptions } from "../agent/evals/cell.ts";
import type { BrowserClient } from "../browser/client.ts";
import {
  bandShare,
  CELL_SITE,
  SLOW_CHUNKS,
  sleep,
  TestBrowserCell,
} from "./testing/browser-cell.ts";
import { DOCKER_TESTS } from "./testing/docker-cli.ts";

// A real browser cell showing a page that keeps its CPUs busy the way a video feed does: frozen
// while nobody uses it, woken by whatever comes next.
const scope = DOCKER_TESTS ? evalCellOptions() : undefined;
const SAMPLE_MS = 10_000;
// browserd leaves a page its task has just used awake through a freeze.
const QUIET_MS = BROWSER_FREEZE_AFTER_USE_MS + 500;

describe.skipIf(!DOCKER_TESTS)("pages nobody uses, frozen in a real browser cell", () => {
  let cell: TestBrowserCell;
  const sessionA = ulid();
  const sessionB = ulid();
  let permitA: BrowserActionPermit;
  let permitB: BrowserActionPermit;
  let tabA = "";
  let tabB = "";
  const measured: Record<string, number | string> = {};

  beforeAll(async () => {
    if (!scope) return;
    cell = await TestBrowserCell.open({
      names: {
        network: `${scope.namePrefix}freeze-net`,
        gate: `${scope.namePrefix}freeze-gate`,
        browser: `${scope.namePrefix}freeze-browser`,
      },
      subnet: "10.233.58",
      label: scope.label,
    });
  }, 600_000);

  afterAll(() => {
    if (!cell) return;
    console.log(cell.logs());
    cell.close();
    console.log("measured", JSON.stringify(measured));
  });

  const freeze = (keep: string[] = []) => cell.lifecycle({ frozen: true, keep });

  it("freezes a busy page nobody uses, and the next look thaws it first", async () => {
    const { client, owner } = cell;
    permitA = await cell.grant(sessionA);
    tabA = (await client.enterWindow(permitA, { fresh: true }, owner)).tabs[0]?.id ?? "";
    await cell.settled(() => client.clock(permitA, tabA, owner));
    await client.navigate(permitA, tabA, `${CELL_SITE}/signin`, owner);
    const busy = await cell.running(permitA, tabA);
    expect(busy.visible).toBe("visible");
    expect(busy.frames).toBeGreaterThan(0);
    await sleep(3000);
    measured.busyCpu = await cell.cpu(SAMPLE_MS);
    measured.busyScreenBand = await cell.screen();

    // The task waits, keeping its grant; nobody watches.
    expect((await freeze()).frozen).toBe(1);
    await sleep(2000);
    measured.frozenCpu = await cell.cpu(SAMPLE_MS);
    // Chromium hides the page it freezes: its window shows no page, not its last picture.
    measured.frozenScreenBand = await cell.screen();
    expect(measured.frozenCpu).toBeLessThan(Number(measured.busyCpu) / 4);
    expect(measured.frozenScreenBand).toBeLessThan(0.02);

    // The task looks without a turn first: browserd wakes and shows the page before reading it.
    const look = await cell.settled(() => client.observe(permitA, tabA, owner));
    const seen = await bandShare(Buffer.from(look.frame.image, "base64"));
    measured.thawedLookBand = seen;
    expect(seen).toBeGreaterThan(0.1);
    const after = await cell.running(permitA, tabA);
    expect(after).toMatchObject({ visible: "visible", cookie: true });
    expect(after.frames).toBeGreaterThan(10);
    expect(after.ticks).toBeGreaterThan(10);
    measured.thawedCpu = await cell.cpu(SAMPLE_MS);
    expect(measured.thawedCpu).toBeGreaterThan(Number(measured.frozenCpu) * 2);
  });

  it("lets a download go on while its page is frozen", async () => {
    const { client, owner } = cell;
    const binding: BrowserDownloadBinding = {
      holder: "agent",
      sessionId: sessionA,
      permit: permitA,
    };
    await client.armDownloads(binding, owner);
    const started = await client.navigate(permitA, tabA, `${CELL_SITE}/slow.bin`, owner);
    expect(started.download).toBe(true);
    const began = performance.now();
    await sleep(QUIET_MS);
    expect((await freeze()).frozen).toBe(1);
    let offers: Awaited<ReturnType<BrowserClient["downloads"]>> = [];
    for (let i = 0; i < 160 && !offers.length; i++) {
      offers = await client.downloads(binding, owner);
      if (!offers.length) await sleep(250);
    }
    measured.frozenDownloadMs = Math.round(performance.now() - began);
    const offer = offers[0];
    if (!offer) throw new Error("the download did not finish");
    expect(offer.bytes).toBe(SLOW_CHUNKS * 65536);
    for await (const _chunk of client.readDownload(binding, offer, owner)) {
      // read through, as the quarantine does
    }
    await client.acknowledgeDownload(binding, offer, owner);
    // Listing and collecting a download read no page: it stays frozen.
    expect(await cell.cpu(5000)).toBeLessThan(Number(measured.busyCpu) / 4);
  });

  it("shows a frozen page again on its task's turn, and on a thaw for someone looking", async () => {
    const { client, owner } = cell;
    await client.enterWindow(permitA, {}, owner);
    measured.turnScreenBand = await cell.screen();
    expect(measured.turnScreenBand).toBeGreaterThan(0.1);
    expect(await cell.running(permitA, tabA)).toMatchObject({ visible: "visible" });

    await sleep(QUIET_MS);
    expect((await freeze()).frozen).toBe(1);
    await sleep(1000);
    expect(await cell.screen()).toBeLessThan(0.02);
    const thawing = performance.now();
    await cell.lifecycle({ frozen: false });
    measured.thawMs = Math.round(performance.now() - thawing);
    await sleep(500);
    // Nothing read the page: the thaw alone brought the window on screen back.
    measured.thawScreenBand = await cell.screen();
    expect(measured.thawScreenBand).toBeGreaterThan(0.1);
    expect((await cell.running(permitA, tabA)).frames).toBeGreaterThan(10);
  });

  it("freezes the window of a task at rest while another task works in its own", async () => {
    const { client, owner } = cell;
    permitB = await cell.grant(sessionB);
    const entered = await client.enterWindow(permitB, { fresh: true }, owner);
    expect(entered.opened).toBe(true);
    tabB = entered.tabs[0]?.id ?? "";
    await cell.settled(() => client.clock(permitB, tabB, owner));
    await client.navigate(permitB, tabB, `${CELL_SITE}/app`, owner);
    expect((await cell.running(permitB, tabB)).frames).toBeGreaterThan(10);
    await sleep(3000);
    // A's page keeps running behind B's window, as a covered window does.
    measured.twoBusyCpu = await cell.cpu(SAMPLE_MS);

    expect((await freeze([sessionB])).frozen).toBe(1);
    await sleep(2000);
    measured.oneFrozenCpu = await cell.cpu(SAMPLE_MS);
    // One busy page can take most of the cell's four CPUs by itself, so the cell's CPU alone can't
    // tell one frozen page from none: what each page does can.
    const calls = await cell.beating(3000);
    measured.frozenPageCalls = calls("/signin");
    measured.workingPageCalls = calls("/app");
    expect(measured.frozenPageCalls).toBe(0);
    expect(measured.workingPageCalls).toBeGreaterThan(5);
    expect(await cell.running(permitB, tabB)).toMatchObject({ visible: "visible" });

    // A's turn brings its window forward, shown and running.
    await client.enterWindow(permitA, {}, owner);
    const a = await cell.running(permitA, tabA);
    expect(a).toMatchObject({ visible: "visible", cookie: true });
    expect(a.frames).toBeGreaterThan(10);
    expect((await cell.supervisor()).restarts).toBe(0);
  });
});
