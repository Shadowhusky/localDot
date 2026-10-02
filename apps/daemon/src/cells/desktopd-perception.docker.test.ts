import type { HitTestResult, ObserveResult } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  copyIntoDesktop,
  type DesktopContainer,
  execAsDesktopUser,
  startDesktopContainer,
  windowGeometry,
} from "./testing/desktop-container.ts";
import { DOCKER_TESTS, dockerExec, removeAll, sleepSync, waitFor } from "./testing/docker-cli.ts";

const C = "localdot-test-perception";
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
  if (path === "/type") {
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.some((line) => "error" in line)).toBe(false);
    expect(lines.at(-1)).toMatchObject({ done: true });
    return lines.at(-1) as T;
  }
  return (await res.json()) as T;
};

describe.skipIf(!DOCKER_TESTS)("desktopd perception at 2x", () => {
  beforeAll(async () => {
    cell = startDesktopContainer(C, 2);
    await post("/launch", { app: "terminal" });
    waitFor("terminal", () => windowGeometry(C, "xfce4-terminal") !== undefined, 30_000);
    sleepSync(2000);
  });
  afterAll(() => removeAll({ containers: [C] }));

  it("hit-tests the terminal's File menu through the GTK mapping", async () => {
    const g = windowGeometry(C, "xfce4-terminal");
    if (!g) throw new Error("no terminal");
    const point = { x: g.x + 40, y: g.y + 26 };
    const hit = await post<HitTestResult>("/hitTest", { point });
    expect(hit.window).toBe(g.id);
    expect(hit.target).toMatchObject({
      source: "ax",
      role: "menu",
      name: "File",
      app: "Xfce4-terminal",
    });
    const b = hit.target?.bbox;
    if (!b) throw new Error("no bbox");
    expect(point.x).toBeGreaterThanOrEqual(b.x);
    expect(point.x).toBeLessThan(b.x + b.w);
    expect(point.y).toBeGreaterThanOrEqual(b.y);
    expect(point.y).toBeLessThan(b.y + b.h);
    expect(b.h).toBe(50);
    expect(hit.ms).toBeLessThan(2500);
  });

  it("observes a 1280x800 WebP with the pointer and the windows", async () => {
    const o = await post<ObserveResult>("/observe", {});
    const bytes = Buffer.from(o.image, "base64");
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString()).toBe("WEBP");
    copyIntoDesktop(C, "/tmp/observe.webp", bytes);
    const identify = dockerExec(C, "identify", "-format", "%m %wx%h", "/tmp/observe.webp");
    expect(identify.status, identify.out).toBe(0);
    expect(identify.out).toBe("WEBP 1280x800");
    expect(o.windows.some((w) => w.cls === "Xfce4-terminal" && w.pid > 0)).toBe(true);
    expect(o.pointer.x).toBeGreaterThanOrEqual(0);
  });

  it("finds Calc's Name Box (GTK-drawn) and places a VCL-drawn sheet tab near the bottom", async () => {
    await post("/launch", { app: "calc" });
    waitFor("calc", () => windowGeometry(C, "libreoffice") !== undefined, 90_000);
    sleepSync(8000);
    const g = windowGeometry(C, "libreoffice");
    if (!g) throw new Error("no calc");
    const nameBox = await post<HitTestResult>("/find", { name: "Name Box" });
    expect(nameBox.target).toMatchObject({
      source: "ax",
      app: expect.stringMatching(/libreoffice|Soffice/i),
    });
    expect(nameBox.target?.bbox?.w).toBeGreaterThan(50);
    const again = await post<HitTestResult>("/hitTest", { point: nameBox.target?.point });
    expect(again.target?.name).toBe(nameBox.target?.name);
    const tab = await post<HitTestResult>("/find", { name: "Sheet1", role: "page tab" });
    const b = tab.target?.bbox;
    if (!b) throw new Error("no sheet tab");
    expect(b.y).toBeGreaterThan(g.y + g.h * 0.8);
    expect(b.y + b.h).toBeLessThanOrEqual(g.y + g.h);
    // Use the found Name Box for real: click it, type B2, Enter — Calc's current cell must become B2.
    await post("/input", {
      input: { kind: "click", button: "left", count: 1, at: nameBox.target?.point },
      window: nameBox.window,
    });
    await post("/type", {
      text: "B2",
      masked: false,
      pace: { firstMs: 20, firstCount: 60, restMs: 6 },
    });
    await post("/input", { input: { kind: "key", combo: ["Return"] } });
    sleepSync(1000);
    const after = await post<HitTestResult>("/find", { name: "Name Box" });
    expect(after.target).toBeDefined();
    const value = execAsDesktopUser(
      C,
      "/usr/bin/python3",
      "-c",
      "import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi\nd=Atspi.get_desktop(0)\n" +
        "def walk(n,depth=0,path=[]):\n    for i in range(min(n.get_child_count(),400)):\n        c=n.get_child_at_index(i)\n        if c is None: continue\n        if c.get_role_name()=='text' and 'Formula Tool Bar' in path:\n            print(Atspi.Text.get_text(c,0,-1)); return True\n        if c.get_role_name() not in ['table','menu'] and depth<28 and walk(c,depth+1,path+[c.get_name()]): return True\n    return False\n" +
        "[walk(d.get_child_at_index(i)) for i in range(d.get_child_count()) if 'soffice' in (d.get_child_at_index(i).get_name() or '').lower()]",
    );
    expect(value.status, value.out).toBe(0);
    expect(value.out.trim()).toBe("B2");
  });
});
