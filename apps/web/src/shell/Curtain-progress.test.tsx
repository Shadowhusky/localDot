// @vitest-environment jsdom
import type { ComputerOperation } from "@localdot/protocol";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerPhase } from "../cells/hud-state.ts";
import { followOperation, type OperationClock, PROGRESS_HOLD } from "../cells/operation-clock.ts";
import type { CellSummary } from "../cells/types.ts";
import { Curtain } from "./Curtain.tsx";

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const ID = "01JXYZ0000000000000000ABCD";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// What a page anchors when a summary arrives now, saying the operation has run `elapsedMs`.
const arrived = (
  elapsedMs: number,
  patch: Partial<ComputerOperation> = {},
  state: CellSummary["state"] = "starting",
): OperationClock | null =>
  followOperation(
    null,
    {
      id: ID,
      state,
      scale: 2,
      createdAt: "2026-10-09T09:00:00.000Z",
      stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
      operation: {
        kind: "start",
        step: "ready",
        startedAt: 1_780_000_000_000,
        elapsedMs,
        expectedMs: 20_000,
        ...patch,
      },
    },
    Date.now(),
  );

interface Shown {
  phase?: ComputerPhase;
  operation?: OperationClock | null;
  ready?: boolean;
  updating?: boolean;
}

const curtain = ({ phase = "starting", operation = null, ready, updating }: Shown) => (
  <Curtain
    phase={phase}
    first={false}
    waking={false}
    updating={updating}
    caption=""
    action={{ kind: "stop", enabled: false }}
    onAction={() => {}}
    operation={operation}
    ready={ready}
    showDot={false}
  />
);

const within = (root: HTMLElement) => ({
  clock: () => root.querySelector(".curtain-sub .num")?.textContent,
  sub: () => root.querySelector(".curtain-sub")?.textContent,
  progress: () =>
    Number(
      root
        .querySelector<HTMLElement>(".curtain-progress > i")
        ?.style.getPropertyValue("--progress"),
    ),
});

const pass = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("the curtain's clock and progress", () => {
  it("carry on from the daemon's start when the curtain comes back mid-start", () => {
    const operation = arrived(12_000);
    const first = render(curtain({ operation }));
    const shown = within(first.container);
    expect(shown.clock()).toBe("0:12");
    const before = shown.progress();
    expect(before).toBeGreaterThan(0.5);
    pass(3_000);
    expect(shown.clock()).toBe("0:15");
    const later = shown.progress();
    expect(later).toBeGreaterThan(before);
    first.unmount();

    const again = within(render(curtain({ operation })).container);
    expect(again.clock()).toBe("0:15");
    expect(again.progress()).toBe(later);
  });

  it("carry on after a refresh, from the elapsed time in the summary the new page reads", () => {
    const page = within(render(curtain({ operation: arrived(12_000) })).container);
    pass(7_000);
    const [clock, progress] = [page.clock(), page.progress()];
    cleanup();
    const reloaded = within(render(curtain({ operation: arrived(19_000) })).container);
    expect(reloaded.clock()).toBe(clock);
    expect(reloaded.progress()).toBe(progress);
  });

  it("show the same on two pages that loaded at different moments", () => {
    const first = arrived(4_000);
    pass(9_500);
    const second = arrived(13_500);
    const a = within(render(curtain({ operation: first })).container);
    const b = within(render(curtain({ operation: second })).container);
    for (let i = 0; i < 4; i++) {
      expect(b.clock()).toBe(a.clock());
      expect(b.progress()).toBe(a.progress());
      pass(1_000);
    }
  });

  it("never go back: steps nudge it on, a missing summary keeps it going, and only ready fills it", () => {
    const seen: number[] = [];
    const view = render(curtain({ operation: arrived(0, { step: "network" }) }));
    const shown = within(view.container);
    const look = () => seen.push(shown.progress());
    look();
    pass(1_000);
    view.rerender(curtain({ operation: arrived(1_000, { step: "desktop" }) }));
    look();
    pass(1_000);
    view.rerender(curtain({ operation: arrived(2_000, { step: "ready" }) }));
    look();
    pass(2_000);
    look();
    // The summary can't be read for a moment: the clock and the bar go on from the same start.
    view.rerender(curtain({ operation: null }));
    expect(shown.clock()).toBe("0:04");
    look();
    pass(3_000);
    expect(shown.clock()).toBe("0:07");
    look();
    view.rerender(curtain({ phase: "connecting", operation: null }));
    expect(shown.sub()).toContain("Your computer is ready. Waiting for its picture…");
    look();
    expect(seen.at(-1)).toBeGreaterThanOrEqual(0.9);
    pass(600_000);
    look();
    expect(seen.at(-1)).toBeLessThanOrEqual(PROGRESS_HOLD);
    view.rerender(curtain({ phase: "connecting", operation: null, ready: true }));
    look();
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++)
      expect(seen[i], `reading ${i}`).toBeGreaterThanOrEqual(seen[i - 1] as number);
  });

  it("say the step the computer is on while it starts, and keep the update's own words", () => {
    const view = render(curtain({ operation: arrived(1_000, { step: "desktop" }) }));
    expect(within(view.container).sub()).toBe("0:01 · Starting the desktop…");
    view.rerender(curtain({ operation: arrived(9_000, { step: "ready" }) }));
    expect(within(view.container).sub()).toBe("0:09 · Waiting for the desktop…");
    view.rerender(
      curtain({ operation: arrived(9_000, { kind: "update", step: "install" }), updating: true }),
    );
    expect(within(view.container).sub()).toBe("0:09 · Your files and sign-ins stay.");
  });

  it("count from when the progress first showed until the daemon says", () => {
    const view = render(curtain({ phase: "stopped" }));
    view.rerender(curtain({ phase: "starting" }));
    const shown = within(view.container);
    expect(shown.sub()).toBe("0:00 · The first start takes about a minute.");
    pass(2_000);
    expect(shown.clock()).toBe("0:02");
    const before = shown.progress();
    view.rerender(curtain({ operation: arrived(1_800, { step: "network" }) }));
    expect(shown.clock()).toBe("0:01");
    expect(shown.progress()).toBeGreaterThanOrEqual(before);
  });
});
