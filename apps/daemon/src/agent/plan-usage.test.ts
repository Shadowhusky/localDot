import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubscriptionUsageData } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PlanRead,
  type PlanReading,
  type PlanUsageDeps,
  PlanUsageStore,
} from "./plan-usage.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "localdot-plan-usage-"));
  homes.push(dir);
  return dir;
}

const T = 1_790_000_000_000;
const claude = (over: Partial<SubscriptionUsageData> = {}): SubscriptionUsageData => ({
  provider: "claude-code",
  plan: "max",
  windows: [
    { window: "primary", usedPercent: 40, windowMinutes: 300, resetsAt: 1_790_010_000 },
    { window: "secondary", usedPercent: 12, windowMinutes: 10_080, resetsAt: 1_790_500_000 },
  ],
  limitReached: false,
  ...over,
});
function store(dir = home(), now = () => T, read?: PlanUsageDeps["read"]) {
  return new PlanUsageStore({ home: dir, now, ...(read ? { read } : {}) });
}

describe("plan usage", () => {
  it("keeps the latest reading of each plan, privately on disk, across restarts", () => {
    const dir = home();
    const plans = store(dir);
    plans.record(claude(), T - 1000);
    plans.record(
      {
        provider: "chatgpt",
        windows: [{ window: "primary", usedPercent: 3, windowMinutes: 300 }],
        limitReached: false,
      },
      T,
    );
    const file = join(dir, "plan-usage.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = store(dir).reply();
    expect(again.checking).toEqual([]);
    expect(again.plans).toEqual([
      {
        provider: "claude-code",
        plan: "max",
        windows: [
          { ...claude().windows[0], observedAt: T - 1000 },
          { ...claude().windows[1], observedAt: T - 1000 },
        ],
        limitReached: false,
        observedAt: T - 1000,
      },
      {
        provider: "chatgpt",
        windows: [{ window: "primary", usedPercent: 3, windowMinutes: 300, observedAt: T }],
        limitReached: false,
        observedAt: T,
      },
    ]);
  });

  it("replaces only the windows a reading carries, each keeping when it was read", () => {
    const plans = store();
    plans.record(claude(), T - 60_000);
    plans.record(
      claude({
        windows: [{ window: "primary", usedPercent: 91, windowMinutes: 300 }],
      }),
      T,
    );
    plans.record(claude({ windows: [] }), T);
    const [plan] = plans.list();
    expect(plan?.windows).toEqual([
      { window: "primary", usedPercent: 91, windowMinutes: 300, observedAt: T },
      { ...claude().windows[1], observedAt: T - 60_000 },
    ]);
    expect(plan?.observedAt).toBe(T);
  });

  it("never lets an older reading overwrite a newer one", () => {
    const plans = store();
    plans.record(claude({ limitReached: true, limitResetsAt: 1_790_010_000 }), T);
    plans.record(
      claude({ windows: [{ window: "primary", usedPercent: 5, windowMinutes: 300 }] }),
      T - 1,
    );
    const [plan] = plans.list();
    expect(plan?.windows[0]?.usedPercent).toBe(40);
    expect(plan?.limitReached).toBe(true);
    expect(plan?.limitResetsAt).toBe(1_790_010_000);
    expect(plan?.observedAt).toBe(T);
  });

  it("starts again when the plan changes and drops a lifted limit's reset time", () => {
    const plans = store();
    plans.record(claude({ limitReached: true, limitResetsAt: 1_790_010_000 }), T - 10);
    plans.record(
      claude({
        plan: "pro",
        windows: [{ window: "secondary", usedPercent: 2, windowMinutes: 10_080 }],
        limitResetsAt: 1_790_010_000,
      }),
      T,
    );
    expect(plans.list()).toEqual([
      {
        provider: "claude-code",
        plan: "pro",
        windows: [{ window: "secondary", usedPercent: 2, windowMinutes: 10_080, observedAt: T }],
        limitReached: false,
        observedAt: T,
      },
    ]);
  });

  it("dates a reading from the future to now", () => {
    const plans = store();
    plans.record(claude(), T + 3_600_000);
    expect(plans.list()[0]?.observedAt).toBe(T);
  });

  it.each([
    ["no provider", { windows: [], limitReached: false }],
    ["another provider", { ...claude(), provider: "anthropic" }],
    ["a percentage past 100", claude({ windows: [{ window: "primary", usedPercent: 150 }] })],
    ["a dollar field", { ...claude(), spentUSD: 1 }],
    ["text", "five hours"],
  ])("ignores a reading with %s", (_, value) => {
    const plans = store();
    plans.record(value, T);
    expect(plans.list()).toEqual([]);
  });

  it("ignores a reading at an impossible time", () => {
    const plans = store();
    for (const at of [Number.NaN, -1, Number.POSITIVE_INFINITY]) plans.record(claude(), at);
    expect(plans.list()).toEqual([]);
  });

  it("starts empty from a damaged file and keeps the good plans of a partly damaged one", () => {
    const dir = home();
    const file = join(dir, "plan-usage.json");
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(store(dir).list()).toEqual([]);
    const good = {
      provider: "chatgpt",
      windows: [{ window: "primary", usedPercent: 3, observedAt: T - 5 }],
      limitReached: false,
      observedAt: T - 5,
    };
    writeFileSync(
      file,
      JSON.stringify({
        plans: [
          good,
          { ...good, provider: "claude-code", windows: [{ window: "primary", usedPercent: 300 }] },
          { ...good, provider: "claude-code", observedAt: T + 60_000 },
        ],
      }),
    );
    expect(store(dir).list()).toEqual([good]);
  });

  it("forgets a plan nobody is signed in to", () => {
    const dir = home();
    const plans = store(dir);
    plans.record(claude(), T);
    plans.forget("claude-code");
    expect(plans.list()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "plan-usage.json"), "utf8"))).toEqual({ plans: [] });
  });
});

describe("reading a plan's usage from its own app", () => {
  it("reads stale plans once at a time, says so meanwhile, and records what it read", async () => {
    let finish!: (reading: PlanReading) => void;
    const read = vi.fn<PlanRead>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const plans = store(home(), () => T, { "claude-code": read });
    const done = plans.refresh();
    void plans.refresh();
    expect(read).toHaveBeenCalledOnce();
    expect(plans.reply().checking).toEqual(["claude-code"]);
    finish({ usage: claude(), observedAt: T });
    await done;
    expect(plans.reply().checking).toEqual([]);
    expect(plans.list()[0]?.windows[0]?.usedPercent).toBe(40);
  });

  it("leaves fresh plans alone and tries a failed read again only after a minute", async () => {
    let now = T;
    const read = vi.fn<PlanRead>(async () => {
      throw new Error("Claude Code didn't answer");
    });
    const plans = store(home(), () => now, { "claude-code": read });
    await plans.refresh();
    now += 30_000;
    await plans.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    now += 30_000;
    await plans.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    plans.record(claude(), now);
    now += 90_000;
    await plans.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    now += 60_000;
    await plans.refresh();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("reads again when a window rests on an old reading even if the plan spoke since", async () => {
    let now = T;
    const read = vi.fn<PlanRead>(async () => undefined);
    const plans = store(home(), () => now, { "claude-code": read });
    plans.record(claude(), now);
    now += 10 * 60_000;
    plans.record(claude({ windows: [] }), now);
    await plans.refresh();
    expect(read).toHaveBeenCalledOnce();
  });

  it("reads a plan that a task reported only one window of, however recently", async () => {
    const read = vi.fn<PlanRead>(async () => undefined);
    const plans = store(home(), () => T, { "claude-code": read });
    const [, weekly] = claude().windows;
    plans.record(claude({ windows: weekly ? [weekly] : [] }), T);
    await plans.refresh();
    expect(read).toHaveBeenCalledOnce();
  });

  it("forgets the plan when its app says nobody is signed in", async () => {
    const plans = store(home(), () => T, { chatgpt: async () => "signed_out" });
    plans.record({ provider: "chatgpt", windows: [], limitReached: true }, T - 600_000);
    await plans.refresh();
    expect(plans.list()).toEqual([]);
  });

  it("drops what a read brings back after closing", async () => {
    let finish!: (reading: PlanReading) => void;
    const plans = store(home(), () => T, {
      "claude-code": (signal) =>
        new Promise((resolve) => {
          finish = resolve;
          expect(signal.aborted).toBe(false);
        }),
    });
    const done = plans.refresh();
    plans.close();
    finish({ usage: claude(), observedAt: T });
    await done;
    expect(plans.list()).toEqual([]);
  });
});
