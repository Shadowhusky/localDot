// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PANELS_KEY, readPanels, usePanelPreferences } from "./panel-preferences.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("restores independent panel choices and the selected view on a new visit", () => {
  const first = renderHook(usePanelPreferences);
  act(() => first.result.current.update({ chat: false }));
  act(() => first.result.current.update({ activity: false, view: "routines" }));
  first.unmount();
  const next = renderHook(usePanelPreferences);
  expect(next.result.current.panels).toEqual({
    chat: false,
    activity: false,
    view: "routines",
    sessions: null,
  });
  act(() => next.result.current.update({ chat: true }));
  expect(readPanels()).toEqual({ chat: true, activity: false, view: "routines", sessions: null });
});

it("accepts valid fields and ignores malformed saved preferences", () => {
  localStorage.setItem(
    PANELS_KEY,
    '{"chat":false,"activity":"false","view":"invalid","sessions":"yes"}',
  );
  expect(readPanels()).toEqual({ chat: false, activity: true, view: "chat", sessions: null });
  localStorage.setItem(PANELS_KEY, "broken");
  expect(readPanels()).toEqual({ chat: true, activity: true, view: "chat", sessions: null });
});

it("keeps successive changes in memory if browser storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const { result } = renderHook(usePanelPreferences);
  act(() => result.current.update({ chat: false }));
  act(() => result.current.update({ activity: false }));
  expect(result.current.panels).toEqual({
    chat: false,
    activity: false,
    view: "chat",
    sessions: null,
  });
});

it("remembers whether the conversations rail was expanded, and leaves it to the layout until then", () => {
  const first = renderHook(usePanelPreferences);
  expect(first.result.current.panels.sessions).toBeNull();
  act(() => first.result.current.update({ sessions: false }));
  first.unmount();
  expect(renderHook(usePanelPreferences).result.current.panels.sessions).toBe(false);
});

it("follows layout changes made in another tab", () => {
  const { result } = renderHook(usePanelPreferences);
  localStorage.setItem(PANELS_KEY, '{"chat":false}');
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: PANELS_KEY })));
  expect(result.current.panels.chat).toBe(false);
});
