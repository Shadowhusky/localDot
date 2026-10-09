// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STILL_MS } from "./focus.ts";
import {
  EDGE_PX,
  isFullScreenChord,
  type KeyPress,
  nearEdge,
  plainKey,
  useEdgeStill,
  useFullScreen,
  useFullScreenKeys,
} from "./fullscreen.ts";

const press = (key: string, over: Partial<KeyPress> = {}): KeyPress => ({
  key,
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  repeat: false,
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document.documentElement, "requestFullscreen");
  Reflect.deleteProperty(document, "exitFullscreen");
  Reflect.deleteProperty(document, "fullscreenElement");
});

describe("full screen keys", () => {
  it("takes ⌘⇧F on a Mac and Ctrl+Shift+F elsewhere, and nothing near it", () => {
    expect(isFullScreenChord(press("F", { meta: true, shift: true }), true)).toBe(true);
    expect(isFullScreenChord(press("f", { ctrl: true, shift: true }), false)).toBe(true);
    expect(isFullScreenChord(press("f", { ctrl: true, shift: true }), true)).toBe(false);
    expect(isFullScreenChord(press("f", { meta: true }), true)).toBe(false);
    expect(isFullScreenChord(press("f", { meta: true, shift: true, alt: true }), true)).toBe(false);
  });

  it("toggles with F while the user watches and leaves with Esc", () => {
    const watching = { full: false, yours: false, busy: false };
    expect(plainKey(press("f"), watching)).toBe("enter");
    expect(plainKey(press("F"), { ...watching, full: true })).toBe("exit");
    expect(plainKey(press("Escape"), { ...watching, full: true })).toBe("exit");
    expect(plainKey(press("Escape"), watching)).toBeNull();
  });

  it("leaves F to the computer, fields and menus, and ignores held or modified keys", () => {
    const watching = { full: false, yours: false, busy: false };
    expect(plainKey(press("f"), { ...watching, yours: true })).toBeNull();
    expect(plainKey(press("f"), { ...watching, busy: true })).toBeNull();
    expect(plainKey(press("Escape"), { ...watching, full: true, busy: true })).toBeNull();
    expect(plainKey(press("f", { repeat: true }), watching)).toBeNull();
    expect(plainKey(press("f", { meta: true }), watching)).toBeNull();
    expect(plainKey(press("f", { shift: true }), watching)).toBeNull();
  });

  it("takes the chord before the computer's keyboard and leaves a key it typed alone", () => {
    const enter = vi.fn(),
      exit = vi.fn();
    const field = document.createElement("textarea");
    document.body.append(field);
    // The computer's keyboard field takes every key it sends, as ManualSurface does.
    field.addEventListener("keydown", (event) => {
      if (!event.defaultPrevented) event.preventDefault();
    });
    const { rerender } = renderHook(
      ({ full }) =>
        useFullScreenKeys({ enabled: true, apple: true, full, yours: true, enter, exit }),
      { initialProps: { full: false } },
    );
    const key = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      field.dispatchEvent(event);
      return event;
    };
    key({ key: "Escape" });
    key({ key: "f" });
    expect(enter).not.toHaveBeenCalled();
    expect(key({ key: "f", metaKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(enter).toHaveBeenCalledOnce();
    rerender({ full: true });
    key({ key: "Escape" });
    expect(exit).not.toHaveBeenCalled();
    key({ key: "f", metaKey: true, shiftKey: true });
    expect(exit).toHaveBeenCalledOnce();
    field.remove();
  });
});

describe("useFullScreen", () => {
  const frame = { current: null };

  it("asks the browser for the whole screen and follows it out when Esc leaves", async () => {
    const request = vi.fn(async () => {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: document.documentElement,
      });
    });
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: request,
    });
    const { result } = renderHook(() => useFullScreen({ available: true, phone: false, frame }));
    await act(async () => result.current.enter());
    expect(request).toHaveBeenCalledOnce();
    expect(result.current.on).toBe(true);
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(result.current.on).toBe(false);
  });

  it("fills the window instead when the browser has no full screen, as on an iPhone", () => {
    const { result } = renderHook(() => useFullScreen({ available: true, phone: true, frame }));
    act(() => result.current.toggle());
    expect(result.current.on).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.on).toBe(false);
  });

  it("leaves the browser's full screen with the button and ends when the picture goes", async () => {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: document.documentElement,
    });
    const leave = vi.fn(async () => {});
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: leave });
    const { result, rerender } = renderHook(
      ({ available }) => useFullScreen({ available, phone: false, frame }),
      { initialProps: { available: true } },
    );
    act(() => result.current.enter());
    expect(result.current.on).toBe(true);
    rerender({ available: false });
    expect(result.current.on).toBe(false);
    expect(leave).toHaveBeenCalledOnce();
    rerender({ available: true });
    expect(result.current.on).toBe(false);
  });
});

describe("useEdgeStill", () => {
  const move = (y: number) =>
    act(() => {
      document.dispatchEvent(new MouseEvent("pointermove", { clientY: y }));
    });

  it("knows the screen's top and foot from the picture between them", () => {
    expect(nearEdge(0, 900)).toBe(true);
    expect(nearEdge(EDGE_PX - 1, 900)).toBe(true);
    expect(nearEdge(EDGE_PX, 900)).toBe(false);
    expect(nearEdge(900 - EDGE_PX - 1, 900)).toBe(false);
    expect(nearEdge(900 - EDGE_PX, 900)).toBe(true);
  });

  it("hides after a still moment and comes back only near the top or the foot", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useEdgeStill(true));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(STILL_MS));
    expect(result.current).toBe(true);
    move(window.innerHeight / 2);
    expect(result.current).toBe(true);
    move(10);
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(STILL_MS - 1));
    move(window.innerHeight / 2);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    move(window.innerHeight - 10);
    expect(result.current).toBe(false);
  });

  it("is never still while full screen is off", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useEdgeStill(false));
    act(() => vi.advanceTimersByTime(STILL_MS * 2));
    expect(result.current).toBe(false);
  });
});
