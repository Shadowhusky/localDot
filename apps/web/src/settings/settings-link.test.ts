// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenForSettingsLinks, takeSettingsLink } from "./settings-link.ts";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("settings links", () => {
  it("reads #settings once, removes it, and lights only a tip of that section", () => {
    window.history.replaceState(null, "", "/?x=1#settings=keys&tip=unlock");
    expect(takeSettingsLink()).toEqual({ section: "keys", tip: "keys-unlock" });
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?x=1");
    window.history.replaceState(null, "", "/#settings=models&tip=unlock");
    expect(takeSettingsLink()).toEqual({ section: "models" });
    window.history.replaceState(null, "", "/#settings=models&tip=chatgpt");
    expect(takeSettingsLink()).toEqual({ section: "models", tip: "models-chatgpt" });
    window.history.replaceState(null, "", "/#settings=nowhere");
    expect(takeSettingsLink()).toBeNull();
    window.history.replaceState(null, "", "/#code=abc");
    expect(takeSettingsLink()).toBeNull();
    expect(window.location.hash).toBe("#code=abc");
  });

  it("opens from the starting address and a fragment change", () => {
    window.history.replaceState(null, "", "/#settings=keys&tip=unlock");
    const open = vi.fn();
    const stop = listenForSettingsLinks(open);
    expect(open).toHaveBeenCalledWith({ section: "keys", tip: "keys-unlock" });
    window.location.hash = "settings=keys";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(open).toHaveBeenLastCalledWith({ section: "keys" });
    stop();
  });
});
