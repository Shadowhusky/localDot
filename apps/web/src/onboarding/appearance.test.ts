// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_EVENT,
  APPEARANCE_KEY,
  DARK_APPEARANCE_KEY,
  resolveAppearance,
  storedAppearance,
} from "./appearance.ts";

// The device's scheme, which a test can flip as the system would.
function device(light: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    get matches() {
      return light;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", (query: string) => {
    expect(query).toBe("(prefers-color-scheme: light)");
    return list;
  });
  return {
    set(next: boolean) {
      light = next;
      for (const listener of listeners) listener();
    },
  };
}

// A fresh copy of the module, as a page load gets: its choice is read from storage once.
const load = async () => {
  vi.resetModules();
  return import("./appearance.ts");
};
const shown = () => document.documentElement.dataset.appearance;
const meta = (name: string) =>
  document.querySelector(`meta[name="${name}"]`)?.getAttribute("content");

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.appearance;
  document.head.innerHTML =
    '<meta name="color-scheme" content="dark" /><meta name="theme-color" content="#0a0b0d" />';
  device(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the stored choice", () => {
  it("is Graphite for a browser that never chose, and for a value no longer offered", () => {
    expect(storedAppearance()).toEqual({ choice: "graphite", dark: "graphite", saved: true });
    for (const old of ["light", "dark", "auto", ""]) {
      localStorage.setItem(APPEARANCE_KEY, old);
      expect(storedAppearance().choice, old).toBe("graphite");
    }
  });

  it("keeps what an earlier version saved, and takes its dark appearance for System", () => {
    localStorage.setItem(APPEARANCE_KEY, "midnight");
    expect(storedAppearance()).toEqual({ choice: "midnight", dark: "midnight", saved: true });
    localStorage.setItem(APPEARANCE_KEY, "graphite");
    expect(storedAppearance()).toEqual({ choice: "graphite", dark: "graphite", saved: true });
  });

  it("reads System and Daylight with the dark appearance saved beside them", () => {
    localStorage.setItem(APPEARANCE_KEY, "system");
    localStorage.setItem(DARK_APPEARANCE_KEY, "midnight");
    expect(storedAppearance()).toMatchObject({ choice: "system", dark: "midnight" });
    localStorage.setItem(APPEARANCE_KEY, "daylight");
    localStorage.setItem(DARK_APPEARANCE_KEY, "daylight");
    expect(storedAppearance()).toMatchObject({ choice: "daylight", dark: "graphite" });
  });

  it("is Graphite when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(storedAppearance()).toEqual({ choice: "graphite", dark: "graphite", saved: true });
  });
});

describe("what a choice shows", () => {
  it("shows a chosen appearance whatever the device", () => {
    for (const choice of ["graphite", "midnight", "daylight"] as const)
      for (const light of [false, true])
        expect(resolveAppearance({ choice, dark: "midnight" }, light)).toBe(choice);
  });

  it("shows Daylight on a light device and the dark appearance on a dark one under System", () => {
    expect(resolveAppearance({ choice: "system", dark: "graphite" }, true)).toBe("daylight");
    expect(resolveAppearance({ choice: "system", dark: "graphite" }, false)).toBe("graphite");
    expect(resolveAppearance({ choice: "system", dark: "midnight" }, false)).toBe("midnight");
  });
});

describe("the page", () => {
  it("opens in the stored appearance before the stylesheet, then tints the chrome once it is in", async () => {
    let tint = "";
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          getPropertyValue: (name: string) => (name === "--color-void" ? tint : ""),
        }) as CSSStyleDeclaration,
    );
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
    device(true);
    localStorage.setItem(APPEARANCE_KEY, "system");
    vi.resetModules();
    await import("./appearance-boot.ts");
    expect(shown()).toBe("daylight");
    expect(meta("color-scheme")).toBe("light");
    frames.shift()?.(0);
    expect(meta("theme-color")).toBe("#0a0b0d");
    tint = "#f2f3f5";
    frames.shift()?.(16);
    expect(meta("theme-color")).toBe("#f2f3f5");
    expect(frames).toHaveLength(0);
  });

  it("tints the browser chrome with the void once the stylesheet is in", async () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => (name === "--color-void" ? " #f2f3f5" : ""),
    } as CSSStyleDeclaration);
    localStorage.setItem(APPEARANCE_KEY, "daylight");
    const { followAppearance } = await load();
    followAppearance();
    expect(meta("theme-color")).toBe("#f2f3f5");
  });

  it("follows the device under System without a reload, and tells the stage", async () => {
    const scheme = device(false);
    localStorage.setItem(APPEARANCE_KEY, "system");
    const { followAppearance } = await load();
    followAppearance();
    expect(shown()).toBe("graphite");
    const told = vi.fn();
    window.addEventListener(APPEARANCE_EVENT, told);
    scheme.set(true);
    expect(shown()).toBe("daylight");
    expect(meta("color-scheme")).toBe("light");
    expect(told).toHaveBeenCalledTimes(1);
    scheme.set(false);
    expect(shown()).toBe("graphite");
    expect(meta("color-scheme")).toBe("dark");
    window.removeEventListener(APPEARANCE_EVENT, told);
  });

  it("keeps a chosen appearance when the device changes", async () => {
    const scheme = device(false);
    localStorage.setItem(APPEARANCE_KEY, "daylight");
    const { followAppearance } = await load();
    followAppearance();
    scheme.set(true);
    scheme.set(false);
    expect(shown()).toBe("daylight");
  });

  it("saves a choice, and System takes the dark appearance chosen last", async () => {
    device(false);
    const { chooseAppearance, currentAppearance, followAppearance, subscribeAppearance } =
      await load();
    followAppearance();
    const heard = vi.fn();
    subscribeAppearance(heard);
    chooseAppearance("midnight");
    chooseAppearance("daylight");
    expect(shown()).toBe("daylight");
    chooseAppearance("system");
    expect(shown()).toBe("midnight");
    expect(localStorage.getItem(APPEARANCE_KEY)).toBe("system");
    expect(localStorage.getItem(DARK_APPEARANCE_KEY)).toBe("midnight");
    expect(currentAppearance()).toEqual({ choice: "system", dark: "midnight", saved: true });
    expect(heard).toHaveBeenCalledTimes(3);
    expect(storedAppearance()).toEqual(currentAppearance());
  });

  it("keeps a choice for the visit when the browser cannot save it", async () => {
    const { chooseAppearance, currentAppearance } = await load();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    chooseAppearance("daylight");
    expect(shown()).toBe("daylight");
    expect(currentAppearance()).toEqual({ choice: "daylight", dark: "graphite", saved: false });
  });

  it("takes a choice made in another tab", async () => {
    const { currentAppearance, followAppearance } = await load();
    followAppearance();
    localStorage.setItem(APPEARANCE_KEY, "midnight");
    window.dispatchEvent(new StorageEvent("storage", { key: APPEARANCE_KEY }));
    expect(shown()).toBe("midnight");
    expect(currentAppearance().choice).toBe("midnight");
  });
});
