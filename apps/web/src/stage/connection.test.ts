// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConnectionInput,
  type ConnectionMemory,
  connectionAt,
  LONG_AWAY_MS,
  NO_CONNECTION,
  type StageConnection,
  stepConnection,
  useStageConnection,
  useStagePicture,
} from "./connection.ts";
import { HELD_AFTER_MS } from "./live-stream.ts";

const COMPUTER = "01JXYZ0000000000000000ABCD";
const at = (input: Partial<ConnectionInput> = {}): ConnectionInput => ({
  computer: COMPUTER,
  screen: "desktop",
  picture: "none",
  screenUp: true,
  resting: false,
  ...input,
});

// Feeds the inputs in turn, each at its time, and says what the stage shows after each.
function run(steps: [number, Partial<ConnectionInput>][]) {
  let memory: ConnectionMemory = NO_CONNECTION;
  return steps.map(([now, input]) => {
    memory = stepConnection(memory, at(input), now);
    return connectionAt(memory, at(input), now);
  });
}
const away = (
  cause: "stream" | "switch" | "browser",
  level: "blip" | "brief" | "long",
  screen: "desktop" | "browser" = "desktop",
): StageConnection => ({ phase: "away", cause, screen, level });

describe("the stage's connection", () => {
  it("is first only until this view has shown a picture", () => {
    expect(
      run([
        [0, {}],
        [5_000, {}],
        [20_000, { picture: "held" }],
      ]),
    ).toEqual([{ phase: "first" }, { phase: "first" }, { phase: "first" }]);
    expect(
      run([
        [0, {}],
        [1_000, { picture: "live" }],
        [2_000, {}],
      ]).at(-1),
    ).toMatchObject({
      phase: "away",
    });
  });

  it("says nothing for a blip, then reconnecting, then what is going on once it lasts", () => {
    expect(
      run([
        [0, { picture: "live" }],
        [100, {}],
        [100 + HELD_AFTER_MS - 1, {}],
        [100 + HELD_AFTER_MS, {}],
        [100 + LONG_AWAY_MS - 1, {}],
        [100 + LONG_AWAY_MS, {}],
        [100 + LONG_AWAY_MS + 50, { picture: "live" }],
      ]),
    ).toEqual([
      { phase: "shown" },
      away("stream", "blip"),
      away("stream", "blip"),
      away("stream", "brief"),
      away("stream", "brief"),
      away("stream", "long"),
      { phase: "shown" },
    ]);
  });

  it("shows a held stream at once: it has already been gone a second", () => {
    expect(
      run([
        [0, { picture: "live" }],
        [10, { picture: "held" }],
      ]).at(-1),
    ).toEqual(away("stream", "brief"));
  });

  it("calls a new screen without a picture a switch, never a first connection", () => {
    expect(
      run([
        [0, { picture: "live" }],
        [10, { screen: "browser" }],
        [2_000, { screen: "browser" }],
        [2_100, { screen: "browser", picture: "live" }],
        // Back to the desktop, whose stream was kept: no gap at all.
        [3_000, { screen: "desktop", picture: "live" }],
      ]),
    ).toEqual([
      { phase: "shown" },
      away("switch", "blip", "browser"),
      away("switch", "brief", "browser"),
      { phase: "shown" },
      { phase: "shown" },
    ]);
  });

  it("says the web browser is restarting, then reconnecting under it without a new blip", () => {
    const shown = run([
      [0, { screen: "browser", picture: "live" }],
      [10, { screen: "browser", screenUp: false }],
      [1_500, { screen: "browser", screenUp: false }],
      [4_000, { screen: "browser" }],
      [4_000 + LONG_AWAY_MS, { screen: "browser" }],
    ]);
    expect(shown).toEqual([
      { phase: "shown" },
      away("browser", "blip", "browser"),
      away("browser", "brief", "browser"),
      away("stream", "brief", "browser"),
      away("stream", "long", "browser"),
    ]);
  });

  it("starts the clock afresh after a pause or a hidden page, whose own words say why", () => {
    expect(
      run([
        [0, { picture: "live" }],
        [10, { resting: true }],
        [60_000, { resting: true }],
        [60_010, {}],
        [60_500, {}],
        [61_000, { picture: "suspended" }],
        [200_000, { picture: "suspended" }],
        [200_010, {}],
      ]),
    ).toEqual([
      { phase: "shown" },
      { phase: "shown" },
      { phase: "shown" },
      away("stream", "blip"),
      away("stream", "blip"),
      { phase: "shown" },
      { phase: "shown" },
      away("stream", "blip"),
    ]);
  });

  it("forgets what it showed once the computer goes down or another takes its place", () => {
    expect(
      run([
        [0, { picture: "live" }],
        [10, { computer: null }],
        [20, {}],
        [30, { picture: "live" }],
        [40, { computer: "01JXYZ0000000000000000ABCE" }],
      ]),
    ).toEqual([
      { phase: "shown" },
      { phase: "first" },
      { phase: "first" },
      { phase: "shown" },
      {
        phase: "first",
      },
    ]);
  });

  it("keeps its memory when nothing changed, so a render can tell", () => {
    const shown = stepConnection(NO_CONNECTION, at({ picture: "live" }), 0);
    expect(stepConnection(shown, at({ picture: "live" }), 50)).toBe(shown);
    const gone = stepConnection(shown, at(), 100);
    expect(stepConnection(gone, at(), 5_000)).toBe(gone);
  });
});

describe("useStageConnection", () => {
  afterEach(() => vi.useRealTimers());

  it("moves on by itself from a blip to reconnecting to long, and back when the picture returns", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { result, rerender } = renderHook((input: ConnectionInput) => useStageConnection(input), {
      initialProps: at({ picture: "live" }),
    });
    expect(result.current).toEqual({ phase: "shown" });
    rerender(at({ picture: "none" }));
    expect(result.current).toEqual(away("stream", "blip"));
    act(() => vi.advanceTimersByTime(HELD_AFTER_MS));
    expect(result.current).toEqual(away("stream", "brief"));
    act(() => vi.advanceTimersByTime(LONG_AWAY_MS));
    expect(result.current).toEqual(away("stream", "long"));
    expect(vi.getTimerCount()).toBe(0);
    rerender(at({ picture: "live" }));
    expect(result.current).toEqual({ phase: "shown" });
  });
});

describe("useStagePicture", () => {
  it("has no picture of a screen until the stage reports one, nor while its computer is down", () => {
    const { result, rerender } = renderHook(
      ({ screen, up }: { screen: "desktop" | "browser"; up: boolean }) =>
        useStagePicture(screen, up),
      { initialProps: { screen: "desktop", up: true } },
    );
    expect(result.current.picture).toBe("none");
    act(() => result.current.onPicture("live", "desktop"));
    expect(result.current.picture).toBe("live");
    // The commit that selects the browser still holds the desktop's report.
    rerender({ screen: "browser", up: true });
    expect(result.current.picture).toBe("none");
    act(() => result.current.onPicture("live", "browser"));
    expect(result.current.picture).toBe("live");
    // The web browser starts again: its last report is stale at once.
    rerender({ screen: "browser", up: false });
    expect(result.current.picture).toBe("none");
  });
});
