// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  chooseStreamPreference,
  STREAM_PREFERENCE_KEY,
  streamPreference,
  streamPreferenceAdopted,
  useStreamPreference,
} from "./stream-preference.ts";

const showToast = vi.fn();

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  chooseStreamPreference("auto");
});

it("reads this browser's choice once, Auto when it has none or an unknown one", () => {
  localStorage.setItem(STREAM_PREFERENCE_KEY, "blurry");
  expect(streamPreference()).toBe("auto");
});

it("applies a choice at once, keeps it for this browser, and says when it couldn't", () => {
  expect(chooseStreamPreference("sharp")).toBe(true);
  expect(streamPreference()).toBe("sharp");
  expect(localStorage.getItem(STREAM_PREFERENCE_KEY)).toBe("sharp");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("private window");
  });
  expect(chooseStreamPreference("smooth")).toBe(false);
  expect(streamPreference()).toBe("smooth");
});

it("shows switching until the stream adopts the newest preference, even when quality is unchanged", () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useStreamPreference(showToast));
  act(() => result.current.change("sharp"));
  expect(showToast).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Switching to Sharp…" }),
  );
  act(() => result.current.change("smooth"));
  streamPreferenceAdopted("sharp", { framerate: 30, crf: 25 });
  expect(showToast).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Switching to Smooth…" }),
  );
  streamPreferenceAdopted("smooth", { framerate: 30, crf: 25 });
  expect(showToast).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Smooth preference active",
      description: expect.stringContaining("picture may look unchanged"),
    }),
  );
  act(() => vi.advanceTimersByTime(3000));
  expect(showToast).toHaveBeenCalledTimes(3);
});

it("does not claim an offline stream applied a preference and confirms it after reconnecting", () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useStreamPreference(showToast));
  act(() => result.current.change("sharp"));
  act(() => vi.advanceTimersByTime(3000));
  expect(showToast).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Sharp preference saved",
      description: expect.stringContaining("when connected"),
    }),
  );
  streamPreferenceAdopted("sharp", { framerate: 30, crf: 25 });
  expect(showToast).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Sharp preference active" }),
  );
});
