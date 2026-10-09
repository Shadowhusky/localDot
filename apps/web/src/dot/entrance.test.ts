// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ENTRANCE_HOLD_MS, useEntrance } from "./entrance.ts";
import type { PresencePlace } from "./presence-rules.ts";

afterEach(() => vi.useRealTimers());

const entrance = (place: PresencePlace, provisional: boolean) =>
  renderHook(
    (props: { place: PresencePlace; provisional: boolean }) =>
      useEntrance(props.place, props.provisional),
    { initialProps: { place, provisional } },
  );

it("enters straight where it will sit once the guess is settled", () => {
  vi.useFakeTimers();
  const h = entrance("hero", true);
  expect(h.result.current).toBeNull();
  vi.advanceTimersByTime(ENTRANCE_HOLD_MS / 3);
  h.rerender({ place: "dock", provisional: false });
  expect(h.result.current).toBe("dock");
});

it("enters at the guess when nothing settles it in time", () => {
  vi.useFakeTimers();
  const h = entrance("hero", true);
  act(() => vi.advanceTimersByTime(ENTRANCE_HOLD_MS));
  expect(h.result.current).toBe("hero");
});

it("never hides again once it has entered", () => {
  const h = entrance("dock", false);
  expect(h.result.current).toBe("dock");
  h.rerender({ place: "hero", provisional: true });
  expect(h.result.current).toBe("hero");
});
