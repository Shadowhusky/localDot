import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Point } from "@localdot/protocol";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EvalCell,
  evalCellOptions,
  removeEvalContainers,
  startEvalCell,
} from "../agent/evals/cell.ts";
import { type OracleCall, oracleModel, type Policy } from "../agent/evals/oracle.ts";
import {
  click,
  drag,
  key,
  modifierClick,
  type Rect,
  scripted,
  windowTitled,
} from "../agent/evals/policy.ts";
import { runAgent } from "../agent/evals/stack.ts";
import { ORACLE_BINDING } from "../agent/evals/suite.ts";
import { DesktopdClient } from "../desktopd/client.ts";
import { DOCKER_TESTS } from "./testing/docker-cli.ts";

// A fresh 2× desktop with the cell's own label and name prefix (LOCALDOT_EVAL_* as in the desktop
// eval), never one of the live computer's localdot-* containers.
const options = DOCKER_TESTS ? evalCellOptions() : undefined;
let cell: EvalCell;
let desktop: DesktopdClient;
const HOME = "/config";
const LEFT_BUTTON = 0x100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
const titled = (title: RegExp) => async () =>
  (await desktop.observe()).windows.find((w) => title.test(w.title));

function shell(script: string): string {
  const r = cell.exec(["sh", "-c", script]);
  if (r.status !== 0) throw new Error(`the cell's shell failed: ${r.err}`);
  return r.out.trim();
}

// The keys and buttons the X server has down, and where the pointer is (a test-side check only).
function down(): { keys: number[]; buttons: number; at: Point } {
  return JSON.parse(
    shell(
      [
        "/usr/bin/python3 -c '",
        "import json",
        "from Xlib import display",
        "d = display.Display()",
        "km = d.query_keymap()",
        "keys = [i * 8 + b for i, byte in enumerate(km) for b in range(8) if byte >> b & 1]",
        "p = d.screen().root.query_pointer()",
        'print(json.dumps({"keys": keys, "buttons": p.mask & 0x1f00, "at": {"x": p.root_x, "y": p.root_y}}))',
        "'",
      ].join("\n"),
    ),
  );
}
const nothingDown = () => {
  const { keys, buttons } = down();
  return { keys, buttons };
};

const clipboard = () => shell("xclip -o -selection clipboard");

const oracle = (policy: Policy) => (facts: Parameters<typeof oracleModel>[1]) => ({
  binding: ORACLE_BINDING,
  model: oracleModel(policy, facts).model,
});

const agent = (task: string, policy: Policy, timeoutMs = 180_000) =>
  runAgent({
    cell,
    home: mkdtempSync(join(tmpdir(), "localdot-mouse-")),
    task,
    model: oracle(policy),
    timeoutMs,
  });

// Thunar's detailed list: rows 28 px apart under the column header, names in the first column
// (model pixels, as in the desktop eval).
const thunarRow = (w: Rect, index: number) => ({ x: w.x + 229, y: w.y + 101 + 28 * index });

async function thunar(dir: string, title: RegExp) {
  shell("pkill -x thunar-real; sleep 1; true");
  cell.launch(["thunar", `${HOME}/${dir}`]);
  await waitFor("Thunar", titled(title), 60_000);
  await sleep(1500);
}

async function luma(image: string): Promise<{ at(p: Point): number }> {
  const { data, info } = await sharp(Buffer.from(image, "base64"))
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    at: (p) => data[Math.round(p.y) * info.width + Math.round(p.x)] ?? 0,
  };
}

describe.skipIf(!DOCKER_TESTS)("mouse input on a real 2× desktop", () => {
  beforeAll(async () => {
    if (!options) return;
    cell = await startEvalCell("mouse", options);
    desktop = new DesktopdClient({ baseUrl: cell.baseUrl, token: cell.token });
  });
  afterAll(() => {
    if (options && cell) removeEvalContainers(options, cell.name);
  });

  it("drags a file onto a folder in Thunar, through the agent", async () => {
    shell(
      `rm -rf ${HOME}/eval/desk && mkdir -p ${HOME}/eval/desk/archive && echo q > ${HOME}/eval/desk/report.txt`,
    );
    await thunar("eval/desk", /^desk - Thunar$/);
    const desk = /^desk - Thunar$/;
    const run = await agent(
      "Drag report.txt onto the archive folder.",
      scripted(
        [
          {
            name: "drag report.txt onto archive",
            ready: (v) => !!windowTitled(v, desk),
            act: (v) => {
              const w = windowTitled(v, desk)?.rect as Rect;
              const [from, to] = [thunarRow(w, 1), thunarRow(w, 0)];
              return [drag([from.x, from.y], [to.x, to.y])];
            },
          },
        ],
        "Moved report.txt into archive.",
      ),
    );
    expect(run.error).toBeUndefined();
    expect(run.outcome).toBe("done");
    const dispatched = run.events.filter((e) => e.type === "action.dispatch");
    expect(dispatched.map((e) => (e.data as { input: { kind: string } }).input.kind)).toEqual([
      "drag",
    ]);
    expect(shell(`ls -A ${HOME}/eval/desk/archive`)).toBe("report.txt");
    expect(shell(`ls -A ${HOME}/eval/desk`)).toBe("archive");
    expect(nothingDown()).toEqual({ keys: [], buttons: 0 });
  });

  it("adds files to a selection with ctrl+click in Thunar, through the agent", async () => {
    shell(
      `rm -rf ${HOME}/eval/inbox && mkdir -p ${HOME}/eval/inbox/done && for f in 1-alpha 2-beta 3-gamma 4-delta 5-epsilon; do echo $f > ${HOME}/eval/inbox/$f.txt; done`,
    );
    await thunar("eval/inbox", /^inbox - Thunar$/);
    const inbox = /^inbox - Thunar$/;
    const row = (v: Parameters<Policy>[0], i: number) =>
      thunarRow(windowTitled(v, inbox)?.rect as Rect, i);
    const run = await agent(
      "Select 1-alpha.txt, 3-gamma.txt and 5-epsilon.txt, then copy them.",
      // One input a turn: a batch's later clicks would be checked against a screenshot the earlier
      // ones changed.
      scripted(
        [
          {
            name: "select 1-alpha.txt",
            ready: (v) => !!windowTitled(v, inbox),
            act: (v) => [click(row(v, 1).x, row(v, 1).y)],
          },
          {
            name: "add 3-gamma.txt",
            act: (v) => [modifierClick(row(v, 3).x, row(v, 3).y, "ctrl")],
          },
          {
            name: "add 5-epsilon.txt",
            act: (v) => [modifierClick(row(v, 5).x, row(v, 5).y, "ctrl")],
          },
          { name: "copy", act: () => [key("ctrl+c")] },
        ],
        "Copied the three files.",
      ),
    );
    expect(run.error).toBeUndefined();
    expect(clipboard().split("\n")).toEqual([
      `${HOME}/eval/inbox/1-alpha.txt`,
      `${HOME}/eval/inbox/3-gamma.txt`,
      `${HOME}/eval/inbox/5-epsilon.txt`,
    ]);
    expect(nothingDown()).toEqual({ keys: [], buttons: 0 });
    shell("pkill -x thunar-real; true");
  });

  it("selects a range with shift+click in Calc, through the agent", async () => {
    cell.launch(["libreoffice", "--calc", "--norestore"]);
    const calc = await waitFor("Calc", titled(/LibreOffice Calc$/), 120_000);
    await sleep(4000);
    await desktop.input({
      input: { kind: "key", combo: ["ctrl", "Home"] },
      injector: "xtest",
      holdMs: 0,
      window: calc.id,
    });
    await desktop.type(
      {
        text: "11\t12\t13\t14\n21\t22\t23\t24\n31\t32\t33\t34\n41\t42\t43\t44\n",
        masked: false,
        pace: { firstMs: 0, firstCount: 0, restMs: 0 },
        injector: "xtest",
        window: calc.id,
      },
      () => {},
    );
    // A1's box, found by reading the elements down the first column (device pixels).
    const a1 = await waitFor(
      "cell A1",
      async () => {
        for (let y = calc.rect.y + 100; y < calc.rect.y + 700; y += 16) {
          const hit = await desktop.hitTest({ x: calc.rect.x + 200, y });
          if (hit.target?.name === "A1" && hit.target.bbox) return hit.target.bbox;
        }
        return undefined;
      },
      30_000,
    );
    const cellAt = (col: number, row: number) => ({
      x: (a1.x + a1.w * (col + 0.5)) / 2,
      y: (a1.y + a1.h * (row + 0.5)) / 2,
    });
    const run = await agent(
      "Select A1 to C3 and copy it.",
      scripted(
        [
          {
            name: "select A1:C3 and copy",
            act: () => [
              click(cellAt(0, 0).x, cellAt(0, 0).y),
              modifierClick(cellAt(2, 2).x, cellAt(2, 2).y, "shift"),
              key("ctrl+c"),
            ],
          },
        ],
        "Copied A1:C3.",
      ),
    );
    expect(run.error).toBeUndefined();
    expect(clipboard()).toBe("11\t12\t13\n21\t22\t23\n31\t32\t33");
    expect(nothingDown()).toEqual({ keys: [], buttons: 0 });
    shell("pkill -f [s]office; true");
  });

  it("draws a stroke along a drag path in GIMP, and lets go where a stopped drag started", async () => {
    shell(
      `mkdir -p ${HOME}/eval && convert -size 640x400 xc:white -strip -define png:color-type=2 ${HOME}/eval/canvas.png`,
    );
    cell.launch(["gimp", `${HOME}/eval/canvas.png`]);
    const gimp = await waitFor("GIMP", titled(/^\[canvas\].*GIMP$/), 180_000);
    await sleep(3000);
    const welcome = await titled(/^Welcome to GIMP/)();
    if (welcome)
      await desktop.input({
        input: {
          kind: "click",
          button: "left",
          count: 1,
          at: { x: welcome.rect.x + welcome.rect.w - 112, y: welcome.rect.y + welcome.rect.h - 54 },
        },
        injector: "xtest",
        holdMs: 0,
      });
    await waitFor(
      "the welcome dialog closed",
      async () => ((await titled(/^Welcome/)()) ? undefined : true),
      10_000,
    );
    await desktop.input({
      input: { kind: "key", combo: ["p"] },
      injector: "xtest",
      holdMs: 0,
      window: gimp.id,
    });
    await sleep(500);
    const centre = { x: gimp.rect.x + gimp.rect.w / 2, y: gimp.rect.y + gimp.rect.h / 2 };
    const way = Array.from({ length: 9 }, (_, i) => ({
      x: Math.round(centre.x - 300 + i * 75),
      y: Math.round(centre.y + (i % 2 ? 60 : -60)),
    }));
    const before = await luma((await desktop.observe()).image);
    const stroke = await desktop.input({
      input: {
        kind: "drag",
        from: way[0] as Point,
        to: way.at(-1) as Point,
        path: way.slice(1, -1),
        button: "left",
        durationMs: 800,
      },
      injector: "xtest",
      holdMs: 0,
      window: gimp.id,
      dropWindow: gimp.id,
    });
    expect(stroke.releaseMono).toBeGreaterThan(stroke.pressMono);
    await sleep(800);
    const after = await luma((await desktop.observe()).image);
    const model = (p: Point) => ({ x: p.x / 2, y: p.y / 2 });
    const painted = way.filter((p) => before.at(model(p)) > 200 && after.at(model(p)) < 100);
    console.log(`painted ${painted.length} of ${way.length} points of the path`);
    expect(painted.length).toBeGreaterThanOrEqual(8);
    expect(nothingDown()).toEqual({ keys: [], buttons: 0 });

    const from = { x: Math.round(centre.x - 300), y: Math.round(centre.y + 150) };
    const stop = new AbortController();
    const stopping = desktop
      .input(
        {
          input: {
            kind: "drag",
            from,
            to: { x: from.x + 600, y: from.y },
            button: "left",
            durationMs: 6000,
          },
          injector: "xtest",
          holdMs: 0,
          window: gimp.id,
        },
        stop.signal,
      )
      .catch((e: unknown) => e);
    await sleep(1500);
    expect(down().buttons & LEFT_BUTTON).toBe(LEFT_BUTTON);
    stop.abort();
    expect(await stopping).toBeInstanceOf(Error);
    await desktop.release();
    await sleep(300);
    expect(down()).toEqual({ keys: [], buttons: 0, at: from });
  });

  it("lets go of a button held between actions when the agent stops", async () => {
    let turn = 0;
    const running = agent(
      "Hold the mouse button down over the canvas.",
      (): OracleCall[] =>
        turn++ === 0
          ? [["computer", { action: "left_mouse_down", coordinate: [640, 700] }]]
          : [["computer", { action: "wait", duration: 25 }]],
      7000,
    );
    await waitFor(
      "the button going down",
      async () => (down().buttons & LEFT_BUTTON ? true : undefined),
      6000,
    );
    const run = await running;
    expect(run.outcome).toBe("timeout");
    expect(nothingDown()).toEqual({ keys: [], buttons: 0 });
  });

  it("lets go of a button held between actions before the user takes over", async () => {
    let turn = 0;
    let before = 0;
    let after = -1;
    const run = await agent(
      "Hold the mouse button down, then hand the screen over.",
      (): OracleCall[] => {
        turn += 1;
        if (turn === 1)
          return [["computer", { action: "left_mouse_down", coordinate: [640, 700] }]];
        if (turn === 2) {
          before = down().buttons;
          return [["request_takeover", { reason: "other", note: "Finish the stroke yourself." }]];
        }
        after = down().buttons;
        return [["done", { summary: "Handed over." }]];
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.outcome).toBe("done");
    expect(before & LEFT_BUTTON).toBe(LEFT_BUTTON);
    expect(after).toBe(0);
    expect(nothingDown()).toEqual({ keys: [], buttons: 0 });
  });
});
