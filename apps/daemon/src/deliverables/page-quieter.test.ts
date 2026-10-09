import { describe, expect, it } from "vitest";
import { PageQuieter } from "./page-quieter.ts";

// One tag whose attributes parse5 checks each against all before it: minutes at this size.
const slow = (seed = 0) =>
  `<p ${Array.from({ length: 220_000 }, (_, i) => `a${i + seed}`).join(" ")}>x</p>`;
const live = () => new AbortController().signal;

// CPU the whole process spends meanwhile, every thread included: a parse left running spends it all.
async function spentWhile(ms: number): Promise<number> {
  const before = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, ms));
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
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

  it("ends a reading that runs past its time", async () => {
    const quieter = new PageQuieter({ time: 400 });
    const started = performance.now();
    expect(await quieter.page(slow(), live())).toEqual({ refused: "too complex" });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(quieter.running).toBe(0);
    expect(await spentWhile(400)).toBeLessThan(200);
  }, 10_000);

  it("ends a reading once its request is gone, and keeps nothing of it", async () => {
    const quieter = new PageQuieter();
    const page = slow();
    const gone = new AbortController();
    setTimeout(() => gone.abort(), 300);
    const started = performance.now();
    expect(await quieter.page(page, gone.signal)).toEqual({ refused: "stopped" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(quieter.running).toBe(0);
    expect(await spentWhile(400)).toBeLessThan(200);
    const again = new AbortController();
    const reading = quieter.page(page, again.signal);
    expect(quieter.running).toBe(1);
    again.abort();
    expect(await reading).toEqual({ refused: "stopped" });
  }, 10_000);

  it("answers a page it has read from what it found, without reading it again", async () => {
    const quieter = new PageQuieter({ time: 400 });
    const page = slow();
    expect(await quieter.page(page, live())).toEqual({ refused: "too complex" });
    const reading = quieter.page(page, live());
    expect(quieter.running).toBe(0);
    expect(await reading).toEqual({ refused: "too complex" });
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
