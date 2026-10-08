import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HitTestResult, ObserveResult, Point, Rect, WindowInfo } from "@localdot/protocol";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EvalCell,
  evalCellOptions,
  removeEvalContainers,
  startEvalCell,
} from "../agent/evals/cell.ts";
import type { Frame } from "../agent/evals/oracle.ts";
import { findBlock } from "../agent/evals/policy.ts";
import { DesktopdClient } from "../desktopd/client.ts";
import { DOCKER_TESTS } from "./testing/docker-cli.ts";

// A fresh 2× desktop with the cell's own label and name prefix (LOCALDOT_EVAL_* as in the desktop
// eval), never one of the live computer's localdot-* containers.
const options = DOCKER_TESTS ? evalCellOptions() : undefined;
let cell: EvalCell;
let desktop: DesktopdClient;
const HOME = "/config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
};
const inside = (r: Rect, p: Point) =>
  p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;

async function waitFor<T>(
  what: string,
  find: () => Promise<T | undefined>,
  ms: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = await find().catch(() => undefined);
    if (found !== undefined) return found;
    await sleep(500);
  }
  throw new Error(`${what} did not appear`);
}

const windows = async () => (await desktop.observe()).windows;
const titled = (title: RegExp) => async () => (await windows()).find((w) => title.test(w.title));
const active = async () => (await windows()).find((w) => w.active);

// Each test opens what it needs, so it runs on its own.
const APPS = {
  gimp: { title: /^\[canvas\].*GIMP$/, command: ["gimp", `${HOME}/eval/canvas.png`] },
  calc: { title: /LibreOffice Calc$/, command: ["libreoffice", "--calc", "--norestore"] },
  thunar: { title: /Thunar$/, command: ["thunar", HOME] },
} as const;
async function open(name: keyof typeof APPS): Promise<WindowInfo> {
  const app = APPS[name];
  const shown = await titled(app.title)();
  if (shown) return shown;
  cell.launch([...app.command]);
  const win = await waitFor(name, titled(app.title), 180_000);
  await sleep(2000);
  // GIMP greets its first start with a dialog over the image window: its Close button.
  const welcome = await titled(/^Welcome to GIMP/)();
  if (welcome) {
    await click({
      x: welcome.rect.x + welcome.rect.w - 112,
      y: welcome.rect.y + welcome.rect.h - 54,
    });
    await waitFor(
      "welcome closed",
      async () => ((await titled(/^Welcome/)()) ? undefined : true),
      10_000,
    );
  }
  return win;
}

async function frame(o: ObserveResult): Promise<Frame> {
  const { data, info } = await sharp(Buffer.from(o.image, "base64"))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

async function click(at: Point, window?: number | null) {
  await desktop.input({
    input: { kind: "click", button: "left", count: 1, at },
    injector: "xtest",
    holdMs: 0,
    ...(window ? { window } : {}),
  });
}

async function timedHit(point: Point): Promise<{ hit: HitTestResult; wall: number }> {
  const t0 = performance.now();
  const hit = await desktop.hitTest(point);
  return { hit, wall: performance.now() - t0 };
}

// Un-maximises a window and places its client area through the window manager (EWMH).
function place(id: number, r: Rect): void {
  const script = [
    "from Xlib import X, display",
    "from Xlib.protocol import event",
    "d = display.Display(); root = d.screen().root",
    `w = d.create_resource_object("window", ${id})`,
    "def send(name, data):",
    "    ev = event.ClientMessage(window=w, client_type=d.intern_atom(name), data=(32, data))",
    "    root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)",
    "send('_NET_WM_STATE', [0, d.intern_atom('_NET_WM_STATE_MAXIMIZED_VERT'), d.intern_atom('_NET_WM_STATE_MAXIMIZED_HORZ'), 1, 0])",
    "d.sync()",
    "import time; time.sleep(0.5)",
    `send('_NET_MOVERESIZE_WINDOW', [(15 << 8) | (2 << 12), ${r.x}, ${r.y}, ${r.w}, ${r.h}])`,
    "d.sync()",
  ].join("\n");
  const r2 = cell.exec(["/usr/bin/python3", "-c", script]);
  if (r2.status !== 0) throw new Error(`place failed: ${r2.err}`);
}

// Keeps a window above every other, active or not.
function keepAbove(id: number): void {
  const script = [
    "from Xlib import X, display",
    "from Xlib.protocol import event",
    "d = display.Display(); root = d.screen().root",
    `w = d.create_resource_object("window", ${id})`,
    "ev = event.ClientMessage(window=w, client_type=d.intern_atom('_NET_WM_STATE'), data=(32, [1, d.intern_atom('_NET_WM_STATE_ABOVE'), 0, 1, 0]))",
    "root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)",
    "d.sync()",
  ].join("\n");
  const r = cell.exec(["/usr/bin/python3", "-c", script]);
  if (r.status !== 0) throw new Error(`keep above failed: ${r.err}`);
}

// The text a Calc combo box's entry shows, read in the cell (a test-side check only).
function comboText(name: string): string {
  const script = [
    "import gi",
    "gi.require_version('Atspi', '2.0')",
    "from gi.repository import Atspi",
    "d = Atspi.get_desktop(0)",
    "def walk(n, depth=0):",
    "    for i in range(min(n.get_child_count(), 300)):",
    "        c = n.get_child_at_index(i)",
    "        if c is None: continue",
    `        if c.get_role_name() == 'combo box' and c.get_name() == ${JSON.stringify(name)}:`,
    "            p = c.get_parent()",
    "            for j in range(p.get_child_count()):",
    "                t = p.get_child_at_index(j)",
    "                if t.get_role_name() == 'text':",
    "                    print(Atspi.Text.get_text(t, 0, -1)); return True",
    "        if c.get_role_name() not in ('table', 'menu') and depth < 30 and walk(c, depth + 1): return True",
    "    return False",
    "for i in range(d.get_child_count()):",
    "    a = d.get_child_at_index(i)",
    "    if a is not None and 'soffice' in (a.get_name() or '').lower() and walk(a): break",
  ].join("\n");
  const r = cell.exec(["/usr/bin/python3", "-c", script]);
  if (r.status !== 0) throw new Error(`reading ${name} failed: ${r.err}`);
  return r.out.trim();
}

function samplePoints(win: WindowInfo, rows: number, cols: number): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++)
      points.push({
        x: Math.round(win.rect.x + ((j + 0.5) * win.rect.w) / cols),
        y: Math.round(win.rect.y + ((i + 0.5) * win.rect.h) / rows),
      });
  return points;
}

describe.skipIf(!DOCKER_TESTS)("desktopd targets on a real 2× desktop", () => {
  beforeAll(async () => {
    if (!options) return;
    cell = await startEvalCell("target", options);
    desktop = new DesktopdClient({ baseUrl: cell.baseUrl, token: cell.token });
    cell.exec(["mkdir", "-p", `${HOME}/eval`]);
    // No embedded colour profile, so GIMP opens it without asking.
    cell.exec([
      "convert",
      "-size",
      "640x400",
      "xc:white",
      "-strip",
      "-define",
      "png:color-type=2",
      `${HOME}/eval/canvas.png`,
    ]);
  });
  afterAll(() => {
    if (options && cell) removeEvalContainers(options, cell.name);
  });

  it("hit-tests GIMP's colour dialog hex field as text within 300 ms, and focus follows a click", async () => {
    const main = await open("gimp");
    // The foreground swatch: the first black block in the toolbox column (model pixels).
    const f = await frame(await desktop.observe());
    const m = { x: main.rect.x / 2, y: main.rect.y / 2, h: main.rect.h / 2 };
    const swatch = findBlock(f, [0, 0, 0], { x: m.x, y: m.y + 100, w: 110, h: m.h - 100 }, 10, 20);
    if (!swatch) throw new Error("no foreground swatch");
    await click({ x: (swatch.x + 8) * 2, y: (swatch.y + 8) * 2 }, main.id);
    const dialog = await waitFor("colour dialog", titled(/^Change Foreground Colou?r$/), 15_000);
    await sleep(1000);
    // The hex field sits a fixed distance from the dialog's right edge (as in the desktop eval).
    const field = { x: dialog.rect.x + dialog.rect.w - 274, y: dialog.rect.y + 514 };
    const walls: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { hit, wall } = await timedHit(field);
      walls.push(wall);
      expect(hit.window).toBe(dialog.id);
      expect(hit.unknown).toBeUndefined();
      expect(hit.target).toMatchObject({ source: "ax", role: "text", editable: true });
      expect(inside(hit.target?.bbox as Rect, field)).toBe(true);
      expect(hit.ms).toBeLessThanOrEqual(300);
    }
    console.log(`GIMP hex field hit test wall ms: ${walls.map((w) => w.toFixed(0)).join(" ")}`);
    // The field's very left edge, where the user's agent clicked twice and nothing happened.
    const box = (await desktop.hitTest(field)).target?.bbox as Rect;
    const edge = await desktop.hitTest({ x: box.x + 4, y: field.y });
    expect(edge.target?.role).toBe("text");
    await click(field, dialog.id);
    await sleep(300);
    const focus = await desktop.focused();
    expect(focus.window).toBe(dialog.id);
    expect(focus.target).toMatchObject({ source: "ax", role: "text", editable: true });
    expect(inside(focus.target?.bbox as Rect, field)).toBe(true);
    expect(focus.ms).toBeLessThanOrEqual(300);
    await desktop.input({
      input: { kind: "key", combo: ["Escape"] },
      injector: "xtest",
      holdMs: 0,
    });
  });

  it("answers hit tests within 300 ms at the 95th percentile in GIMP, Calc, Thunar and Chromium's UI", async () => {
    const lines: string[] = [];
    const measure = async (name: string, points: Point[]) => {
      const ms: number[] = [];
      const walls: number[] = [];
      let elements = 0;
      for (const p of points) {
        const { hit, wall } = await timedHit(p);
        ms.push(hit.ms);
        walls.push(wall);
        if (hit.target?.source === "ax" || hit.target?.source === "dom") elements++;
        expect(hit.unknown, `${name} at ${p.x},${p.y}`).toBeUndefined();
      }
      lines.push(
        `${name}: n=${ms.length} p50=${percentile(ms, 0.5)} p95=${percentile(ms, 0.95)} max=${Math.max(...ms)} wall p95=${percentile(walls, 0.95).toFixed(0)} elements=${elements}`,
      );
      expect(percentile(ms, 0.95), name).toBeLessThanOrEqual(300);
      expect(elements / points.length, name).toBeGreaterThanOrEqual(0.9);
    };
    const gimp = await open("gimp");
    await click({ x: gimp.frame.x + gimp.frame.w / 2, y: gimp.frame.y + 20 }, gimp.id);
    await measure("GIMP", samplePoints(gimp, 6, 5));
    const calc = await open("calc");
    await measure("Calc", samplePoints(calc, 6, 5));
    const thunar = await open("thunar");
    await measure("Thunar", samplePoints(thunar, 6, 5));
    cell.launch(["/usr/local/bin/localdot-chromium", "about:blank"]);
    const chromium = await waitFor("Chromium", titled(/Chromium$/), 60_000);
    await sleep(3000);
    // Chromium's own UI: the tab strip and the toolbar across the top of its window.
    const top = { ...chromium, rect: { ...chromium.rect, h: 220 } };
    await measure("Chromium UI", samplePoints(top, 2, 15));
    console.log(lines.join("\n"));
    if (process.env.LOCALDOT_EVAL_OUT)
      writeFileSync(
        join(process.env.LOCALDOT_EVAL_OUT, "hit-test-latency.txt"),
        `${lines.join("\n")}\n`,
      );
    cell.exec(["pkill", "-f", "chromium"]);
  });

  it("clicks a Calc font size that its open list shows over another window", async () => {
    const thunar = await open("thunar");
    const calc = await open("calc");
    place(thunar.id, { x: 0, y: 110, w: 2560, h: 1300 });
    place(calc.id, { x: 0, y: 110, w: 1600, h: 600 });
    await click({ x: calc.frame.x + 400, y: calc.frame.y + 20 }, calc.id);
    await sleep(1500);
    const placed = await waitFor(
      "Calc placed",
      async () => {
        const w = await titled(/LibreOffice Calc$/)();
        return w && w.rect.h < 800 && w.active ? w : undefined;
      },
      15_000,
    );
    const arrow = await desktop.find({ name: "Font Size", role: "combo box" });
    if (!arrow.target) throw new Error("no font size box");
    await click(arrow.target.point, arrow.window);
    const list = await waitFor(
      "font size list",
      async () => (await windows()).find((w) => w.overrideRedirect && w.transientFor === placed.id),
      10_000,
    );
    await sleep(500);
    const below = placed.frame.y + placed.frame.h;
    expect(list.rect.y + list.rect.h).toBeGreaterThan(below + 100);
    // An item over Thunar, below Calc's own frame.
    const at = { x: list.rect.x + 60, y: below + 60 };
    const hit = await desktop.hitTest(at);
    expect(hit.window).toBe(list.id);
    expect(hit.target).toMatchObject({ source: "ax", role: "table cell" });
    const size = hit.target?.name ?? "";
    expect(size).toMatch(/pt$/);
    await click(at, hit.window);
    await sleep(1000);
    expect((await active())?.id).toBe(placed.id);
    expect(comboText("Font Size")).toBe(size);
  });

  it("never activates another window while a GTK menu is open over it", async () => {
    const thunar = await open("thunar");
    const gimp = await open("gimp");
    // Thunar stays above GIMP's lower left, where GIMP's File menu opens.
    place(thunar.id, { x: 2, y: 700, w: 1200, h: 500 });
    keepAbove(thunar.id);
    const over = await waitFor(
      "Thunar placed",
      async () => {
        const w = await titled(/Thunar$/)();
        return w && w.frame.y >= 600 ? w : undefined;
      },
      15_000,
    );
    const file = await desktop.find({ name: "File", role: "menu", app: "Gimp" });
    if (!file.target) throw new Error("no File menu");
    await click(file.target.point, file.window);
    const menu = await waitFor(
      "File menu",
      async () => (await windows()).find((w) => w.overrideRedirect && w.transientFor === gimp.id),
      10_000,
    );
    await sleep(500);
    const items: { at: Point; hit: HitTestResult }[] = [];
    const top = Math.max(menu.rect.y, over.frame.y) + 30;
    const bottom = Math.min(menu.rect.y + menu.rect.h, over.frame.y + over.frame.h);
    for (let y = top; y < bottom - 10; y += 40) {
      const at = { x: menu.rect.x + 200, y };
      items.push({ at, hit: await desktop.hitTest(at) });
    }
    expect(items.length).toBeGreaterThan(3);
    for (const { hit } of items) expect(hit.window).toBe(menu.id);
    const template = items.find((i) => i.hit.target?.name === "Create Template...");
    if (!template) throw new Error(`no Create Template: ${items.map((i) => i.hit.target?.name)}`);
    expect(template.hit.target).toMatchObject({ source: "ax", role: "menu item" });
    await click(template.at, template.hit.window);
    const dialog = await waitFor("template dialog", titled(/^Create New Template$/), 10_000);
    expect(dialog.active).toBe(true);
    expect((await windows()).find((w) => w.id === thunar.id)?.active).toBe(false);
    await desktop.input({
      input: { kind: "key", combo: ["Escape"] },
      injector: "xtest",
      holdMs: 0,
    });
  });
});
