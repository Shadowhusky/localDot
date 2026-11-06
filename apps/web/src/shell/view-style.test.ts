// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { switchViewLabel, useViewStyle, VIEW_STYLE_KEY, VIEWS_TRIED_KEY } from "./view-style.ts";

function device(phone: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: phone && query.includes("coarse"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  window.matchMedia = globalThis.matchMedia;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the view style", () => {
  it("is Chat on a phone and Studio anywhere else until one is chosen", () => {
    device(true);
    expect(renderHook(useViewStyle).result.current).toMatchObject({
      value: "chat",
      recommended: "chat",
    });
    cleanup();
    device(false);
    expect(renderHook(useViewStyle).result.current).toMatchObject({
      value: "studio",
      recommended: "studio",
    });
  });

  it("keeps a choice for this device, and ignores anything else it finds there", () => {
    device(false);
    localStorage.setItem(VIEW_STYLE_KEY, "chat");
    expect(renderHook(useViewStyle).result.current.value).toBe("chat");
    cleanup();
    localStorage.setItem(VIEW_STYLE_KEY, "sideways");
    expect(renderHook(useViewStyle).result.current.value).toBe("studio");
  });

  it("counts moving to the other style as trying it, and a pick in setup as not", () => {
    device(false);
    const { result } = renderHook(useViewStyle);
    act(() => result.current.choose("chat"));
    expect(result.current).toMatchObject({ value: "chat", tried: false });
    expect(localStorage.getItem(VIEW_STYLE_KEY)).toBe("chat");
    expect(localStorage.getItem(VIEWS_TRIED_KEY)).toBeNull();
    act(() => result.current.change("studio"));
    expect(result.current).toMatchObject({ value: "studio", tried: true });
    expect(localStorage.getItem(VIEWS_TRIED_KEY)).toBe("on");
  });

  it("follows another tab's choice", () => {
    device(false);
    const { result } = renderHook(useViewStyle);
    localStorage.setItem(VIEW_STYLE_KEY, "chat");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: VIEW_STYLE_KEY }));
    });
    expect(result.current.value).toBe("chat");
  });

  it("names the other style in the menu's words", () => {
    expect(switchViewLabel("chat")).toBe("Switch to Studio view");
    expect(switchViewLabel("studio")).toBe("Switch to Chat view");
  });
});
