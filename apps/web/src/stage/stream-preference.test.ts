// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  chooseStreamPreference,
  STREAM_PREFERENCE_KEY,
  streamPreference,
} from "./stream-preference.ts";

afterEach(() => {
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
