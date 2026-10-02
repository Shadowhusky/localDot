import type { HitTestResult } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DesktopContainer,
  execAsDesktopUser,
  startDesktopContainer,
  windowGeometry,
} from "./testing/desktop-container.ts";
import { DOCKER_TESTS, dockerExec, removeAll, sleepSync, waitFor } from "./testing/docker-cli.ts";

const C = "localdot-test-cdp";
let cell: DesktopContainer;
const post = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`${cell.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cell.token}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

// ImageMagick: paint everything but the colour white, the colour black, and read the trim box.
function pixelBox(colour: string): { x: number; y: number; w: number; h: number } {
  expect(execAsDesktopUser(C, "sh", "-c", "import -window root /tmp/shot.png").status).toBe(0);
  const trim = dockerExec(
    C,
    "convert",
    "/tmp/shot.png",
    "-fuzz",
    "8%",
    "-fill",
    "white",
    "+opaque",
    colour,
    "-fill",
    "black",
    "-opaque",
    colour,
    "-format",
    "%@",
    "info:",
  );
  expect(trim.status, trim.out).toBe(0);
  const out = trim.out.trim();
  const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(out);
  if (!m) throw new Error(`no trim box for ${colour}: ${out}`);
  return { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
}

const within = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  px: number,
) =>
  Math.abs(a.x - b.x) <= px &&
  Math.abs(a.y - b.y) <= px &&
  Math.abs(a.w - b.w) <= px &&
  Math.abs(a.h - b.h) <= px;

describe.skipIf(!DOCKER_TESTS)("Chromium web content through CDP at 2x", () => {
  beforeAll(async () => {
    cell = startDesktopContainer(C, 2);
    await post("/launch", { app: "chromium", args: ["file:///opt/localdot/marker.html"] });
    waitFor("chromium", () => windowGeometry(C, "chromium") !== undefined, 60_000);
    sleepSync(5000);
  });
  afterAll(() => removeAll({ containers: [C] }));

  it("maps a web element's box within 1 px of its pixels, maximized", async () => {
    const red = pixelBox("rgb(255,0,0)");
    const point = { x: red.x + red.w / 2, y: red.y + red.h / 2 };
    const hit = await post<HitTestResult>("/hitTest", { point });
    expect(hit.target).toMatchObject({
      source: "dom",
      role: "button",
      name: "marker red",
      url: "file:///opt/localdot/marker.html",
    });
    expect(
      hit.target?.bbox && within(hit.target.bbox, red, 1),
      JSON.stringify({ got: hit.target?.bbox, want: red }),
    ).toBe(true);
    expect(hit.ms).toBeLessThan(500);
  });

  it("still maps within 1 px after the window is restored", async () => {
    expect(execAsDesktopUser(C, "xdotool", "key", "alt+F10").status).toBe(0);
    sleepSync(2000);
    const g = windowGeometry(C, "chromium");
    expect(g?.w).toBeLessThan(2560);
    const blue = pixelBox("rgb(0,0,255)");
    const hit = await post<HitTestResult>("/hitTest", {
      point: { x: blue.x + blue.w / 2, y: blue.y + blue.h / 2 },
    });
    expect(hit.target?.name).toBe("marker blue");
    expect(
      hit.target?.bbox && within(hit.target.bbox, blue, 1),
      JSON.stringify({ got: hit.target?.bbox, want: blue }),
    ).toBe(true);
    expect(execAsDesktopUser(C, "xdotool", "key", "alt+F10").status).toBe(0);
    sleepSync(2000);
  });

  it("finds by accessible name and flags the password field", async () => {
    const green = pixelBox("rgb(0,255,0)");
    const found = await post<HitTestResult>("/find", { name: "marker green", role: "button" });
    expect(found.target?.bbox && within(found.target.bbox, green, 1)).toBe(true);
    const pw = await post<HitTestResult>("/find", { name: "Password" });
    expect(pw.target).toMatchObject({ secret: true });
    const typed = await post<HitTestResult>("/hitTest", { point: pw.target?.point });
    expect(typed.target?.secret).toBe(true);
  });

  it("detects a password field reached by Tab while the pointer stays on a button", async () => {
    const button = await post<HitTestResult>("/find", { name: "marker red" });
    await post("/input", {
      input: { kind: "click", button: "left", count: 1, at: button.target?.point },
      window: button.window,
    });
    for (let i = 0; i < 3; i++) await post("/input", { input: { kind: "key", combo: ["Tab"] } });
    const focus = await post<HitTestResult>("/focused", {});
    expect(focus.target).toMatchObject({ name: "Password", secret: true });
    const hover = await post<HitTestResult>("/hitTest", { point: button.target?.point });
    expect(hover.target?.secret).not.toBe(true);
  });
});
