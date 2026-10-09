// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  changeVoicePrefs,
  DEFAULT_VOICE,
  readVoicePrefs,
  useVoicePrefs,
  VOICE_KEY,
} from "./prefs.ts";

afterEach(() => localStorage.clear());

describe("voice choices", () => {
  it("start with both extras off and the browser's language", () => {
    expect(readVoicePrefs()).toEqual({ language: "auto", online: false, readAloud: false });
  });

  it("ignore what they can't use", () => {
    localStorage.setItem(VOICE_KEY, JSON.stringify({ language: "<script>", online: "yes" }));
    expect(readVoicePrefs()).toEqual(DEFAULT_VOICE);
    localStorage.setItem(VOICE_KEY, "not json");
    expect(readVoicePrefs()).toEqual(DEFAULT_VOICE);
  });

  it("are kept in this browser and shared with every reader on the page", () => {
    const a = renderHook(() => useVoicePrefs());
    const b = renderHook(() => useVoicePrefs());
    act(() => changeVoicePrefs({ readAloud: true, language: "zh-CN" }));
    expect(a.result.current.value).toMatchObject({ readAloud: true, language: "zh-CN" });
    expect(b.result.current.value.readAloud).toBe(true);
    expect(JSON.parse(localStorage.getItem(VOICE_KEY) ?? "{}")).toMatchObject({ readAloud: true });
  });
});
