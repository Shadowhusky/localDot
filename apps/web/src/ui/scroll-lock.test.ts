// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { lockScroll } from "./scroll-lock.ts";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
});

describe("lockScroll", () => {
  it("holds the page still until the last lock is released, then restores it", () => {
    document.documentElement.style.overflow = "auto";
    const first = lockScroll();
    const second = lockScroll();
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.documentElement.dataset.scrollLocked).toBe("");
    first();
    first();
    expect(document.documentElement.style.overflow).toBe("hidden");
    second();
    expect(document.documentElement.style.overflow).toBe("auto");
    expect(document.documentElement.dataset.scrollLocked).toBeUndefined();
  });

  it("pads the body by the scrollbar it hides, so nothing moves", () => {
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: window.innerWidth - 15,
    });
    try {
      const release = lockScroll();
      expect(document.body.style.paddingRight).toBe("15px");
      release();
      expect(document.body.style.paddingRight).toBe("");
    } finally {
      Reflect.deleteProperty(document.documentElement, "clientWidth");
    }
  });

  it("adds no style element", () => {
    const before = document.querySelectorAll("style").length;
    const release = lockScroll();
    expect(document.querySelectorAll("style")).toHaveLength(before);
    release();
  });
});
