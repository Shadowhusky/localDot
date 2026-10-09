// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusRow } from "../session/status.ts";
import {
  type BandScene,
  dayPart,
  greeting,
  type IdleInput,
  nextTip,
  rankTips,
  restingBand,
  seenTips,
  TIP_MS,
  TIPS_KEY,
  useIdleLine,
  usePageHidden,
} from "./idle-line.ts";
import { GREETINGS, TIPS, type Tip, type TipSignals } from "./tips.ts";

const SIGNALS: TipSignals = {
  touch: false,
  apple: true,
  recordings: true,
  update: false,
  freshStart: false,
};
const THREE: Tip[] = [
  { id: "a", text: "Tip a." },
  { id: "b", text: "Tip b.", action: { label: "Open", opens: "replay" } },
  { id: "c", text: "Tip c." },
];

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MORNING = new Date(2026, 9, 9, 8, 30);

function idle(input: Partial<IdleInput> = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(MORNING);
  const props: IdleInput = { resting: true, held: false, signals: SIGNALS, tips: THREE, ...input };
  return renderHook((next: IdleInput) => useIdleLine(next), { initialProps: props });
}
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("when dot rests", () => {
  const scene = (over: Partial<BandScene>): BandScene => ({
    row: "ready",
    computer: "live",
    attention: null,
    line: "",
    covered: false,
    ...over,
  });

  it("rests only with the computer up, no task at work and nothing waiting on the user", () => {
    for (const row of ["ready", "done", "stopped"] as StatusRow[])
      expect(restingBand(scene({ row })), row).toBe(true);
    const busy: StatusRow[] = [
      "acting",
      "thinking",
      "observing",
      "working",
      "question",
      "approval",
      "takeover",
      "control",
      "waiting",
      "pausing",
      "paused",
      "resuming",
      "recovery",
      "retrying",
      "limit",
      "interrupted",
      "failed",
      "stopping",
      "computer",
    ];
    for (const row of busy) expect(restingBand(scene({ row })), row).toBe(false);
  });

  it("stays quiet while the band has its own line, something covers it, or the computer isn't up", () => {
    expect(restingBand(scene({ line: "Thinking this through is taking a while." }))).toBe(false);
    expect(restingBand(scene({ covered: true }))).toBe(false);
    expect(restingBand(scene({ attention: "needs_you" }))).toBe(false);
    expect(restingBand(scene({ computer: "reconnecting" }))).toBe(false);
    expect(restingBand(scene({ computer: "none" }))).toBe(false);
  });

  it("says nothing of its own once a task, a question or an approval starts", () => {
    const view = idle();
    expect(view.result.current?.text).toBeTruthy();
    view.rerender({ resting: false, held: false, signals: SIGNALS, tips: THREE });
    expect(view.result.current).toBeNull();
    wait(TIP_MS * 3);
    expect(view.result.current).toBeNull();
    expect(seenTips()).toEqual([]);
  });
});

describe("greetings", () => {
  it("knows the part of the day by the hour", () => {
    const parts = Array.from({ length: 24 }, (_, hour) => dayPart(hour));
    expect(parts.slice(5, 12).every((part) => part === "morning")).toBe(true);
    expect(parts.slice(12, 18).every((part) => part === "afternoon")).toBe(true);
    expect(parts.slice(18, 23).every((part) => part === "evening")).toBe(true);
    expect([...parts.slice(0, 5), parts[23]].every((part) => part === "night")).toBe(true);
  });

  it("picks one of that part's lines", () => {
    const at = (hour: number) => new Date(2026, 9, 9, hour);
    expect(greeting(at(7), 0)).toBe(GREETINGS.morning[0]);
    expect(greeting(at(14), 0.999)).toBe(GREETINGS.afternoon.at(-1));
    expect(GREETINGS.evening).toContain(greeting(at(20)));
    expect(GREETINGS.night).toContain(greeting(at(2)));
  });

  it("opens an idle screen with a greeting for the hour, then a tip after a while", () => {
    const view = idle();
    expect(GREETINGS.morning).toContain(view.result.current?.text);
    expect(view.result.current?.action).toBeUndefined();
    wait(TIP_MS - 1);
    expect(GREETINGS.morning).toContain(view.result.current?.text);
    wait(1);
    expect(view.result.current?.text).toBe("Tip a.");
  });

  it("greets once a visit: after a task it waits a turn, then goes on with the tips", () => {
    const view = idle();
    wait(TIP_MS);
    view.rerender({ resting: false, held: false, signals: SIGNALS, tips: THREE });
    view.rerender({ resting: true, held: false, signals: SIGNALS, tips: THREE });
    expect(view.result.current).toBeNull();
    wait(TIP_MS);
    expect(view.result.current?.text).toBe("Tip b.");
  });
});

describe("tips", () => {
  it("rotates through every tip before any repeats, and carries each one's step", () => {
    const view = idle();
    const shown: string[] = [];
    const steps: (string | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      wait(TIP_MS);
      shown.push(view.result.current?.text ?? "");
      steps.push(view.result.current?.action?.label);
    }
    expect(shown.slice(0, 3)).toEqual(["Tip a.", "Tip b.", "Tip c."]);
    expect(steps.slice(0, 3)).toEqual([undefined, "Open", undefined]);
    expect(new Set(shown.slice(3)).size).toBe(3);
    expect(shown[3]).not.toBe("Tip c.");
  });

  it("remembers what this viewer has seen, so the next visit goes on from there", () => {
    const first = idle();
    wait(TIP_MS);
    wait(TIP_MS);
    expect(first.result.current?.text).toBe("Tip b.");
    expect(first.result.current?.action).toEqual({ label: "Open", opens: "replay" });
    expect(JSON.parse(localStorage.getItem(TIPS_KEY) ?? "")).toEqual(["a", "b"]);
    first.unmount();
    const next = idle();
    expect(GREETINGS.morning).toContain(next.result.current?.text);
    wait(TIP_MS);
    expect(next.result.current?.text).toBe("Tip c.");
  });

  it("still rotates when the browser won't store anything", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const view = idle();
    wait(TIP_MS);
    expect(view.result.current?.text).toBe("Tip a.");
    wait(TIP_MS);
    expect(view.result.current?.text).toBe("Tip b.");
  });

  it("puts tips for features the user hasn't used first, and the ones they use last", () => {
    const ids = (signals: Partial<TipSignals>) =>
      rankTips(TIPS, { ...SIGNALS, ...signals }).map((tip) => tip.id);
    const fresh = ids({ routines: 0, exported: false });
    expect(fresh.slice(0, 3)).toEqual(["routine", "replay-export", "showcase"]);
    const busy = ids({ routines: 4, exported: true });
    expect(busy.slice(-3)).toEqual(["routine", "replay-export", "showcase"]);
    expect(ids({}).indexOf("routine")).toBe(1);
    const next = nextTip(rankTips(TIPS, { ...SIGNALS, routines: 0 }), ["take-control"]);
    expect(next?.tip.id).toBe("routine");
  });

  it("offers only tips for what this screen has", () => {
    const ids = (signals: Partial<TipSignals>) =>
      rankTips(TIPS, { ...SIGNALS, ...signals }).map((tip) => tip.id);
    expect(ids({ touch: true })).not.toContain("full-screen");
    expect(ids({ touch: true })).not.toContain("stop-key");
    expect(ids({ recordings: false })).not.toContain("replay-export");
    expect(ids({})).not.toContain("update");
    expect(ids({ update: true })[0]).toBe("update");
    expect(ids({ openAtLogin: "unavailable" })).not.toContain("open-at-login");
  });

  it("waits while the page is hidden or the pointer is over the band, then gives the tip its full turn", () => {
    const view = idle();
    view.rerender({ resting: true, held: true, signals: SIGNALS, tips: THREE });
    wait(TIP_MS * 3);
    expect(GREETINGS.morning).toContain(view.result.current?.text);
    expect(seenTips()).toEqual([]);
    view.rerender({ resting: true, held: false, signals: SIGNALS, tips: THREE });
    wait(TIP_MS - 1);
    expect(GREETINGS.morning).toContain(view.result.current?.text);
    wait(1);
    expect(view.result.current?.text).toBe("Tip a.");
  });

  it("knows when the page is hidden", () => {
    let state: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    const view = renderHook(() => usePageHidden());
    expect(view.result.current).toBe(false);
    state = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(view.result.current).toBe(true);
  });
});
