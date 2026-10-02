import { describe, expect, it } from "vitest";
import { appToolkit, elementToolkit, frameToDevice, menuBarHeight } from "./mapping.ts";

describe("frameToDevice (D13, S2 measurements)", () => {
  it("GTK3 at 2x with window scaling 2: Thunar's File menu at a window whose origin is odd", () => {
    // S2: raw menu File (0,39) 39×27 for a window at device (1,78) → the menu sits at the window's top-left.
    expect(
      frameToDevice({ x: 0, y: 39, w: 39, h: 27 }, "gtk", {
        g: 2,
        c: 2,
        m: 27,
        windowOrigin: { x: 1, y: 78 },
      }),
    ).toEqual({ x: 1, y: 78, w: 78, h: 54 });
    // Plain frame × g would give (0, 78): off by one at the odd origin (carry-forward).
  });

  it("GTK3 at 1x is the identity", () => {
    expect(
      frameToDevice({ x: 1057, y: 634, w: 31, h: 40 }, "gtk", {
        g: 1,
        c: 1,
        m: 27,
        windowOrigin: { x: 0, y: 27 },
      }),
    ).toEqual({ x: 1057, y: 634, w: 31, h: 40 });
  });

  it("LibreOffice GTK-drawn parts follow the GTK rule, VCL-drawn parts shift by the menu bar", () => {
    const p = { g: 2, c: 2, m: 27, windowOrigin: { x: 0, y: 77 } };
    // S2 at 2x GTK×2: File (0,38) 39×27 → device (0,77); New (4,40) 45×36 is a toolbar button, one menu bar too high.
    expect(frameToDevice({ x: 0, y: 38, w: 39, h: 27 }, "libreoffice-gtk", p)).toEqual({
      x: 0,
      y: 77,
      w: 78,
      h: 54,
    });
    expect(frameToDevice({ x: 4, y: 40, w: 45, h: 36 }, "libreoffice-vcl", p)).toEqual({
      x: 8,
      y: 134,
      w: 90,
      h: 72,
    });
    // 1x: New (4,52) is on screen at y 79–115.
    expect(
      frameToDevice({ x: 4, y: 52, w: 45, h: 36 }, "libreoffice-vcl", {
        g: 1,
        c: 1,
        m: 27,
        windowOrigin: { x: 0, y: 50 },
      }),
    ).toEqual({ x: 4, y: 79, w: 45, h: 36 });
  });

  it("Chromium browser chrome scales by the device scale factor", () => {
    // S2: root frame 1050×753 at (10,37) for an X window 2100×1506+20+74.
    expect(
      frameToDevice({ x: 10, y: 37, w: 1050, h: 753 }, "chromium-chrome", {
        g: 2,
        c: 2,
        m: 27,
        windowOrigin: { x: 20, y: 74 },
      }),
    ).toEqual({ x: 20, y: 74, w: 2100, h: 1506 });
  });
});

describe("toolkit classification", () => {
  it("classifies apps by WM_CLASS", () => {
    expect(appToolkit("Chromium")).toBe("chromium");
    expect(appToolkit("libreoffice-calc")).toBe("libreoffice");
    expect(appToolkit("Soffice")).toBe("libreoffice");
    expect(appToolkit("Thunar")).toBe("gtk");
    expect(appToolkit("Xfce4-terminal")).toBe("gtk");
  });

  it("marks LibreOffice's VCL-drawn parts per role and tool-bar ancestry, GTK-drawn text fields never", () => {
    expect(elementToolkit("libreoffice", { role: "menu", inWeb: false }, [])).toBe(
      "libreoffice-gtk",
    );
    expect(elementToolkit("libreoffice", { role: "button", inWeb: false }, ["tool bar"])).toBe(
      "libreoffice-vcl",
    );
    expect(elementToolkit("libreoffice", { role: "panel", inWeb: false }, ["tool bar"])).toBe(
      "libreoffice-vcl",
    );
    expect(
      elementToolkit("libreoffice", { role: "text", inWeb: false }, ["panel", "tool bar"]),
    ).toBe("libreoffice-gtk");
    expect(elementToolkit("libreoffice", { role: "table", inWeb: false }, [])).toBe(
      "libreoffice-vcl",
    );
    expect(
      elementToolkit("libreoffice", { role: "page tab", inWeb: false }, ["page tab list"]),
    ).toBe("libreoffice-vcl");
    expect(elementToolkit("libreoffice", { role: "button", inWeb: false }, ["page tab list"])).toBe(
      "libreoffice-gtk",
    );
    expect(elementToolkit("chromium", { role: "button", inWeb: false }, [])).toBe(
      "chromium-chrome",
    );
    expect(elementToolkit("chromium", { role: "link", inWeb: true }, [])).toBe("chromium-web");
    expect(elementToolkit("gtk", { role: "anything", inWeb: true }, [])).toBe("gtk");
  });

  it("reads the native menu bar height from the menu rows, 27 by default", () => {
    expect(
      menuBarHeight([
        { role: "menu", frame: { x: 0, y: 50, w: 39, h: 27 }, depth: 2 },
        { role: "menu", frame: { x: 0, y: 50, w: 36, h: 22 }, depth: 3 },
      ]),
    ).toBe(27);
    expect(menuBarHeight([])).toBe(27);
    expect(menuBarHeight([{ role: "menu", frame: { x: 0, y: 125, w: 60, h: 45 }, depth: 2 }])).toBe(
      45,
    );
  });
});
