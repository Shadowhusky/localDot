import { describe, expect, it } from "vitest";
import { appToolkit, frameToDevice } from "./mapping.ts";

describe("frameToDevice (D13, S2 measurements)", () => {
  it("GTK3 at 2x with window scaling 2: Thunar's File menu at a window whose origin is odd", () => {
    // S2: raw menu File (0,39) 39×27 for a window at device (1,78) → the menu sits at the window's top-left.
    expect(
      frameToDevice({ x: 0, y: 39, w: 39, h: 27 }, "gtk", {
        g: 2,
        c: 2,
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
        windowOrigin: { x: 0, y: 27 },
      }),
    ).toEqual({ x: 1057, y: 634, w: 31, h: 40 });
  });

  it("places LibreOffice's corrected frames by the GTK rule", () => {
    // Calc at device (0,110): cell B3 reports (119,247) 82×17 once its VCL offset is corrected.
    expect(
      frameToDevice({ x: 119, y: 247, w: 82, h: 17 }, "gtk", {
        g: 2,
        c: 2,
        windowOrigin: { x: 0, y: 110 },
      }),
    ).toEqual({ x: 238, y: 494, w: 164, h: 34 });
  });

  it("Chromium browser chrome scales by the device scale factor", () => {
    // S2: root frame 1050×753 at (10,37) for an X window 2100×1506+20+74.
    expect(
      frameToDevice({ x: 10, y: 37, w: 1050, h: 753 }, "chrome", {
        g: 2,
        c: 2,
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
});
