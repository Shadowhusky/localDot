import { cameraFor, toCanvas } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import {
  browserCamera,
  browserWindow,
  desktopPoint,
  MENU_BAR_PX,
  type StagePoint,
  stagePoint,
  TITLE_BAR_PX,
} from "./composite.ts";

const DESKTOP = { w: 2560, h: 1600 };
const WINDOW = browserWindow(DESKTOP);
// A stage as wide as the picture, drawn one to one, and a phone's, a third of its CSS px.
const LARGE = { left: 0, top: 0, width: 1280, height: 800 };
const BACKING = { w: 2560, h: 1600 };
const PHONE = { left: 0, top: 0, width: 390, height: 243.75 };
const PHONE_BACKING = { w: 1170, h: 731 };
const at = (x: number, y: number) => ({ x, y });
const hit = (point: { x: number; y: number }, within?: StagePoint | null) =>
  stagePoint(LARGE, DESKTOP, point, BACKING, "browser", within);

describe("the web browser's window on the desktop", () => {
  it("sits under the menu bar and its title bar, its whole picture at one scale", () => {
    expect(WINDOW.top).toBe(MENU_BAR_PX * 2);
    expect(WINDOW.y).toBe((MENU_BAR_PX + TITLE_BAR_PX) * 2);
    expect(WINDOW.h).toBe(1600 - 104);
    expect(WINDOW.w / WINDOW.h).toBeCloseTo(1.6, 6);
    expect(WINDOW.x).toBeCloseTo((2560 - WINDOW.w) / 2, 6);
    expect(browserWindow({ w: 1280, h: 800 })).toMatchObject({
      top: MENU_BAR_PX,
      y: MENU_BAR_PX + TITLE_BAR_PX,
    });
  });

  it("draws a browser pixel where a press there lands on that pixel", () => {
    const camera = browserCamera(
      cameraFor({ stageW: 2560, stageH: 1600, desktopW: 2560, desktopH: 1600, zoom: 1 }),
      WINDOW,
    );
    for (const pixel of [at(0, 0), at(1280, 800), at(2559, 1599), at(731, 88)]) {
      const canvas = toCanvas(camera, pixel);
      const landed = stagePoint(LARGE, DESKTOP, at(canvas.x / 2, canvas.y / 2), BACKING, "browser");
      expect(landed?.screen).toBe("browser");
      expect(Math.abs((landed?.x ?? -9) - pixel.x)).toBeLessThanOrEqual(2);
      expect(Math.abs((landed?.y ?? -9) - pixel.y)).toBeLessThanOrEqual(2);
    }
  });

  it("maps a browser point back to the desktop's pixels", () => {
    expect(desktopPoint(at(0, 0), WINDOW)).toEqual({ x: WINDOW.x, y: WINDOW.y });
    const end = desktopPoint(at(2560, 1600), WINDOW);
    expect(end.x).toBeCloseTo(WINDOW.x + WINDOW.w);
    expect(end.y).toBeCloseTo(1600);
  });
});

describe("what a pointer on the stage reaches", () => {
  it("gives the desktop everything while the desktop is in front", () => {
    expect(stagePoint(LARGE, DESKTOP, at(100, 10), BACKING, "desktop")).toEqual({
      x: 200,
      y: 20,
      screen: "desktop",
    });
    expect(stagePoint(LARGE, DESKTOP, at(640, 400), BACKING, "desktop")?.screen).toBe("desktop");
  });

  it("gives the window to the browser and the bar above it to the desktop", () => {
    expect(hit(at(640, 400))?.screen).toBe("browser");
    expect(hit(at(640, 10))).toEqual({ x: 1280, y: 20, screen: "desktop" });
    expect(hit(at(640, MENU_BAR_PX - 1))?.screen).toBe("desktop");
    expect(hit(at(640, MENU_BAR_PX + TITLE_BAR_PX))?.screen).toBe("browser");
  });

  it("gives neither screen the window's title bar, which is the stage's own", () => {
    expect(hit(at(640, MENU_BAR_PX))).toBeNull();
    expect(hit(at(640, MENU_BAR_PX + TITLE_BAR_PX - 1))).toBeNull();
    // Beside it is the desktop behind, as beside the window.
    expect(hit(at(5, MENU_BAR_PX + 4))).toMatchObject({ screen: "desktop", behind: true });
  });

  it("gives a margin beside the window to the desktop behind it, to bring forward and no more", () => {
    expect(hit(at(5, 400))).toEqual({ x: 10, y: 800, screen: "desktop", behind: true });
    expect(hit(at(1275, 400))).toMatchObject({ screen: "desktop", behind: true });
    expect(hit(at(WINDOW.x / 2 + 1, 400))?.screen).toBe("browser");
    // A press there stays behind, wherever it goes, and never reaches the browser.
    expect(hit(at(640, 400), hit(at(5, 400)))).toMatchObject({ screen: "desktop", behind: true });
  });

  it("keeps a press on the screen it began on, at that screen's edge", () => {
    const inBrowser = hit(at(640, 400));
    expect(hit(at(640, 2), inBrowser)).toMatchObject({ screen: "browser", y: 0 });
    expect(hit(at(0, 400), inBrowser)).toMatchObject({ screen: "browser", x: 0 });
    expect(hit(at(2000, 5000), inBrowser)).toMatchObject({ screen: "browser", x: 2559, y: 1599 });
    const onBar = hit(at(640, 10));
    expect(hit(at(640, 500), onBar)).toEqual({ x: 1280, y: 1000, screen: "desktop" });
  });

  it("takes nothing on a bar too thin to aim at, on a phone's stage, but a tap beside the window", () => {
    const tap = (x: number, y: number) =>
      stagePoint(PHONE, DESKTOP, at(x, y), PHONE_BACKING, "browser");
    expect(tap(195, 3)).toBeNull();
    expect(tap(195, 120)?.screen).toBe("browser");
    expect(tap(1, 120)).toMatchObject({ screen: "desktop", behind: true });
    const narrow = { ...PHONE, width: 240, height: 150 };
    expect(stagePoint(narrow, DESKTOP, at(1, 75), PHONE_BACKING, "browser")).toBeNull();
  });

  it("is off the stage, off every screen", () => {
    expect(hit(at(-1, 400))).toBeNull();
    expect(hit(at(640, 900))).toBeNull();
  });
});
