import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { cpuLimited, type LaunchReader, launchReader, PageQuieter } from "./page-quieter.ts";

// One tag whose attributes parse5 checks each against all before it: minutes at this size.
const slow = (seed = 0) =>
  `<p ${Array.from({ length: 220_000 }, (_, i) => `a${i + seed}`).join(" ")}>x</p>`;
// Over a million elements, each kept until the page is written out again.
const heavy = () => "<br>".repeat(1_250_000);
const live = () => new AbortController().signal;
const gone = (child: ChildProcess | undefined) =>
  child !== undefined && (child.exitCode !== null || child.signalCode !== null);

// Launches readers as the daemon does, remembering each.
function watched(): { launch: LaunchReader; readers: ChildProcess[] } {
  const readers: ChildProcess[] = [];
  return {
    readers,
    launch: (limits) => {
      const child = launchReader(limits);
      readers.push(child);
      return child;
    },
  };
}

describe("quieting a page apart from the daemon", () => {
  it("answers as quietPage does", async () => {
    const quieter = new PageQuieter();
    expect(await quieter.page("<a href=x target=_blank>x</a>", live())).toEqual({
      body: '<html><head></head><body><a href="x">x</a></body></html>',
    });
    expect(await quieter.page(`${"<div>".repeat(200)}x`, live())).toEqual({
      refused: "not shown",
    });
  });

  it("ends a reading that spends its CPU, and answers that page from then on without reading it", async () => {
    const { launch, readers } = watched();
    const quieter = new PageQuieter({ cpu: 1 }, launch);
    const page = slow();
    const started = performance.now();
    expect(await quieter.page(page, live())).toEqual({ refused: "too complex" });
    expect(performance.now() - started).toBeLessThan(4000);
    expect(quieter.running).toBe(0);
    expect(readers[0]?.signalCode).toBe("SIGXCPU");
    const again = quieter.page(page, live());
    expect(quieter.running).toBe(0);
    expect(await again).toEqual({ refused: "too complex" });
    expect(readers).toHaveLength(1);
  }, 15_000);

  it("sets only the soft CPU limit, so Linux ends a reader with SIGXCPU and not SIGKILL", () => {
    const limited = cpuLimited(1, "/bin/sh", ["-c", "ulimit -S -t; ulimit -H -t"]);
    const [soft, hard] = execFileSync("/bin/sh", limited, { encoding: "utf8" }).trim().split("\n");
    expect(soft).toBe("1");
    expect(hard).not.toBe("1");
  });

  it("refuses a page that runs its reader out of heap, keeps nothing, and reads the next", async () => {
    const { launch, readers } = watched();
    const quieter = new PageQuieter({ heap: 48 }, launch);
    const page = heavy();
    expect(await quieter.page(page, live())).toEqual({ refused: "too complex" });
    expect(readers[0]?.signalCode).toBe("SIGABRT");
    expect(await quieter.page("<p>still here</p>", live())).toEqual({
      body: "<html><head></head><body><p>still here</p></body></html>",
    });
    const again = quieter.page(page, live());
    expect(quieter.running).toBe(1);
    expect(await again).toEqual({ refused: "too complex" });
  }, 20_000);

  it("keeps nothing of a reading only the clock cut short, as on a busy Mac", async () => {
    const { launch, readers } = watched();
    const quieter = new PageQuieter({ cpu: 30, time: 300 }, launch);
    const page = slow();
    const started = performance.now();
    expect(await quieter.page(page, live())).toEqual({ refused: "busy" });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(gone(readers[0])).toBe(true);
    const again = quieter.page(page, live());
    expect(quieter.running).toBe(1);
    expect(await again).toEqual({ refused: "busy" });
    expect(readers).toHaveLength(2);
  }, 10_000);

  it("keeps nothing when a reader could not start", async () => {
    let launches = 0;
    const quieter = new PageQuieter({}, (limits) =>
      ++launches === 1 ? spawn("/nonexistent/localdot-reader", []) : launchReader(limits),
    );
    expect(await quieter.page("<p>once</p>", live())).toEqual({ refused: "busy" });
    expect(quieter.running).toBe(0);
    expect(await quieter.page("<p>once</p>", live())).toEqual({
      body: "<html><head></head><body><p>once</p></body></html>",
    });
    expect(launches).toBe(2);
  });

  it("ends a reading once its request is gone, and keeps nothing of it", async () => {
    const { launch, readers } = watched();
    const quieter = new PageQuieter({}, launch);
    const page = slow();
    const leaving = new AbortController();
    setTimeout(() => leaving.abort(), 300);
    const started = performance.now();
    expect(await quieter.page(page, leaving.signal)).toEqual({ refused: "stopped" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(quieter.running).toBe(0);
    expect(gone(readers[0])).toBe(true);
    const again = new AbortController();
    const reading = quieter.page(page, again.signal);
    expect(quieter.running).toBe(1);
    again.abort();
    expect(await reading).toEqual({ refused: "stopped" });
  }, 10_000);

  it("turns a page away while too many wait, and lets a waiting one go when its request is", async () => {
    const quieter = new PageQuieter({ running: 1, waiting: 1 });
    const first = new AbortController();
    const second = new AbortController();
    const reading = quieter.page(slow(), first.signal);
    const waiting = quieter.page(slow(1), second.signal);
    expect(await quieter.page("<p>third</p>", live())).toEqual({ refused: "busy" });
    second.abort();
    expect(await waiting).toEqual({ refused: "stopped" });
    expect(quieter.running).toBe(1);
    first.abort();
    expect(await reading).toEqual({ refused: "stopped" });
    expect(quieter.running).toBe(0);
    expect(await quieter.page("<p>next</p>", live())).toEqual({
      body: "<html><head></head><body><p>next</p></body></html>",
    });
  }, 10_000);
});
