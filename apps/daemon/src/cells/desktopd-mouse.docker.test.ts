import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Input, Point } from "@localdot/protocol";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EvalCell,
  evalCellOptions,
  removeEvalContainers,
  startEvalCell,
} from "../agent/evals/cell.ts";
import { decodeImage } from "../agent/evals/checks.ts";
import { type OracleCall, oracleModel, type Policy } from "../agent/evals/oracle.ts";
import {
  click,
  drag,
  findBlock,
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
// A screen worth looking at, when the run keeps its output.
async function keep(name: string): Promise<void> {
  const out = process.env.LOCALDOT_EVAL_OUT;
  if (out) writeFileSync(join(out, name), Buffer.from((await desktop.observe()).image, "base64"));
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

  it("draws a stroke along a drag path in GIMP, and a stopped stroke draws nothing back to its start", async () => {
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

    // An L: along the top, then down the right side. Stopped on the second leg, nothing may join
    // the pointer back to the start, which would cross the column under the first leg's middle.
    const start = { x: Math.round(centre.x - 250), y: Math.round(centre.y - 150) };
    const corner = { x: Math.round(centre.x + 250), y: start.y };
    const end = { x: corner.x, y: Math.round(centre.y + 250) };
    const unpainted = await luma((await desktop.observe()).image);
    const stop = new AbortController();
    const stopping = desktop
      .input(
        {
          input: {
            kind: "drag",
            from: start,
            to: end,
            path: [corner],
            button: "left",
            durationMs: 4000,
          },
          injector: "xtest",
          holdMs: 0,
          window: gimp.id,
        },
        stop.signal,
      )
      .catch((e: unknown) => e);
    await sleep(3200);
    expect(down().buttons & LEFT_BUTTON).toBe(LEFT_BUTTON);
    const stoppedAt = down().at;
    stop.abort();
    expect(await stopping).toBeInstanceOf(Error);
    await desktop.release();
    await sleep(1200);
    const stopped = await luma((await desktop.observe()).image);
    await keep("stopped-stroke.png");
    // Let go where the stroke stopped (it may have moved on a sample before the Stop landed).
    const lifted = down();
    expect(lifted).toMatchObject({ keys: [], buttons: 0 });
    expect(Math.hypot(lifted.at.x - stoppedAt.x, lifted.at.y - stoppedAt.y)).toBeLessThan(80);
    expect(lifted.at.y).toBeGreaterThan(start.y + 40);
    const crossed: number[] = [];
    // The first leg's brush reaches some 30 px below it.
    for (const dx of [-100, 0])
      for (let y = start.y + 40; y < end.y; y += 4) {
        const p = model({ x: centre.x + dx, y });
        if (unpainted.at(p) > 200 && stopped.at(p) < 100) crossed.push(y);
      }
    console.log(
      `first leg after the stop: ${[0.3, 0.6].map((t) => stopped.at(model({ x: start.x + (corner.x - start.x) * t, y: start.y })))}`,
    );
    expect(crossed).toEqual([]);
  });

  describe("a button held between actions over files", () => {
    const deskTitle = /^desk - Thunar$/;
    type Rows = Record<"archive" | "share" | "report", Point>;
    // Thunar sorts folders first: archive, share, then report.txt.
    async function desk() {
      shell(
        `rm -rf ${HOME}/eval/desk && mkdir -p ${HOME}/eval/desk/archive ${HOME}/eval/desk/share && echo q > ${HOME}/eval/desk/report.txt`,
      );
      await thunar("eval/desk", deskTitle);
    }
    const where = () => ({
      desk: shell(`ls -A ${HOME}/eval/desk`).split("\n"),
      archive: shell(`ls -A ${HOME}/eval/desk/archive`),
      share: shell(`ls -A ${HOME}/eval/desk/share`),
    });
    const untouched = { desk: ["archive", "report.txt", "share"], archive: "", share: "" };
    const press = (p: Point): OracleCall => [
      "computer",
      { action: "left_mouse_down", coordinate: [p.x, p.y] },
    ];
    const hover = (p: Point): OracleCall => [
      "computer",
      { action: "mouse_move", coordinate: [p.x, p.y] },
    ];
    const release = (p?: Point): OracleCall => [
      "computer",
      { action: "left_mouse_up", ...(p ? { coordinate: [p.x, p.y] } : {}) },
    ];
    // One input a turn, then done.
    const turns = (plan: ((rows: Rows) => OracleCall)[]): Policy => {
      let rows: Rows | undefined;
      let turn = 0;
      return (v) => {
        const w = windowTitled(v, deskTitle)?.rect as Rect | undefined;
        if (w && !rows)
          rows = { archive: thunarRow(w, 0), share: thunarRow(w, 1), report: thunarRow(w, 2) };
        const next = rows && plan[turn++];
        return next ? [next(rows as Rows)] : [["done", { summary: "Done." }]];
      };
    };
    const cards = (run: Awaited<ReturnType<typeof agent>>) =>
      run.events
        .filter((e) => e.type === "approval.request")
        .map((e) => e.data as { title: string; preview?: { fields?: [string, string][] } });
    const autoRelease = (run: Awaited<ReturnType<typeof agent>>) =>
      run.events.filter(
        (e) =>
          e.type === "action.intent" &&
          (e.data as { label: string }).label === "Release the left button, cancelling the drag",
      );

    it("asks for the release as a drag from the file to the folder under the drag, and drops it there", async () => {
      await desk();
      const run = await agent(
        "Move report.txt into archive.",
        turns([(r) => press(r.report), (r) => hover(r.archive), () => release()]),
      );
      expect(run.error).toBeUndefined();
      const fields = cards(run).at(-1)?.preview?.fields ?? [];
      console.log(`release card: ${JSON.stringify(cards(run).at(-1))}`);
      expect(fields).toContainEqual(["Target", "report.txt"]);
      expect(fields).toContainEqual(["Drop target", "archive"]);
      expect(fields).toContainEqual(["Action", "release a mouse button"]);
      expect(fields.map(([k]) => k)).toContain("Drag");
      expect(where()).toEqual({ desk: ["archive", "share"], archive: "report.txt", share: "" });
      expect(nothingDown()).toEqual({ keys: [], buttons: 0 });
    });

    it("asks for a held move over a folder it may not drop on, and drops nothing there", async () => {
      await desk();
      const run = await agent(
        "Put report.txt in share.",
        turns([(r) => press(r.report), (r) => hover(r.share), () => release()]),
      );
      expect(run.assisted.denied).toContain("post");
      expect(cards(run).find((c) => c.title === "Publish content")?.preview?.fields).toContainEqual(
        ["Drop target", "share"],
      );
      expect(where()).toEqual(untouched);
      expect(nothingDown()).toEqual({ keys: [], buttons: 0 });
    });

    it("cancels the drag when the task ends with the button held over a folder", async () => {
      await desk();
      const run = await agent(
        "Put report.txt in archive.",
        turns([(r) => press(r.report), (r) => hover(r.archive)]),
      );
      expect(run.outcome).toBe("done");
      await sleep(1000);
      expect(where()).toEqual(untouched);
      expect(autoRelease(run)).toHaveLength(1);
      expect(nothingDown()).toEqual({ keys: [], buttons: 0 });
    });

    it("cancels the drag when its release was denied and the task then ends", async () => {
      await desk();
      const run = await agent(
        "Put report.txt in share.",
        turns([(r) => press(r.report), (r) => hover(r.archive), (r) => release(r.share)]),
      );
      expect(run.assisted.denied).toContain("post");
      await sleep(1000);
      expect(where()).toEqual(untouched);
      expect(nothingDown()).toEqual({ keys: [], buttons: 0 });
    });

    it("cancels the drag when the task is stopped with the button held over a folder", async () => {
      await desk();
      const run = await agent(
        "Put report.txt in archive.",
        turns([
          (r) => press(r.report),
          (r) => hover(r.archive),
          () => ["computer", { action: "wait", duration: 30 }],
        ]),
        20_000,
      );
      expect(run.outcome).toBe("timeout");
      await sleep(1000);
      expect(where()).toEqual(untouched);
      expect(nothingDown()).toEqual({ keys: [], buttons: 0 });
    });

    it("cancels the drag before the user takes over", async () => {
      await desk();
      let during: ReturnType<typeof where> | undefined;
      let buttons = -1;
      const run = await agent(
        "Hold report.txt over archive, then hand the screen over.",
        turns([
          (r) => press(r.report),
          (r) => hover(r.archive),
          () => ["request_takeover", { reason: "other", note: "Finish moving the file yourself." }],
          () => {
            during = where();
            buttons = down().buttons;
            return ["done", { summary: "Handed over." }];
          },
        ]),
      );
      expect(run.error).toBeUndefined();
      expect(buttons).toBe(0);
      expect(during).toEqual(untouched);
      expect(where()).toEqual(untouched);
    });

    it("cancels the drag after its time without a mouse action, and that time stands still while an approval waits", async () => {
      await desk();
      // Over the list's empty space, below the rows: a folder would spring open under a long hover.
      const slow = await runAgent({
        cell,
        home: mkdtempSync(join(tmpdir(), "localdot-mouse-")),
        task: "Drag report.txt below the list and let go.",
        model: oracle(
          turns([
            (r) => press(r.report),
            (r) => hover({ x: r.report.x, y: r.report.y + 28 * 4 }),
            () => release(),
          ]),
        ),
        timeoutMs: 180_000,
        heldButtonMs: 12_000,
        approvalDelayMs: 15_000,
      });
      console.log(`after the slow approvals: ${(await titled(/Thunar$/)())?.title}`);
      expect(slow.error).toBeUndefined();
      expect(autoRelease(slow)).toEqual([]);
      const ups = slow.events.filter(
        (e) => e.type === "action.dispatch" && (e.data as { input: Input }).input.kind === "up",
      );
      expect(ups).toHaveLength(1);
      expect(where()).toEqual(untouched);

      await desk();
      const idle = await runAgent({
        cell,
        home: mkdtempSync(join(tmpdir(), "localdot-mouse-")),
        task: "Hold report.txt over archive.",
        model: oracle(
          turns([
            (r) => press(r.report),
            (r) => hover(r.archive),
            () => ["computer", { action: "wait", duration: 20 }],
          ]),
        ),
        timeoutMs: 180_000,
        heldButtonMs: 8000,
      });
      expect(idle.error).toBeUndefined();
      expect(autoRelease(idle)).toHaveLength(1);
      expect(where()).toEqual(untouched);
      expect(nothingDown()).toEqual({ keys: [], buttons: 0 });
    });
  });

  it("drags a range input and reorders a sortable list on a Chromium page, and a stopped reorder changes nothing", async () => {
    // XTest presses and min-jerk motion, as the browser screen sends them, into a real page.
    const page = `<!doctype html><html><head><title>loading</title><style>
body { margin: 0; font: 20px sans-serif; }
#origin { position: absolute; left: 0; top: 0; width: 20px; height: 20px; background: #f0f; }
#volume { position: absolute; left: 100px; top: 100px; width: 600px; height: 40px; margin: 0; }
ul { position: absolute; left: 100px; top: 250px; width: 300px; list-style: none; margin: 0; padding: 0; }
li { height: 60px; line-height: 60px; margin: 0 0 10px; padding-left: 16px; background: #ddd; }
</style></head><body>
<div id="origin"></div>
<input id="volume" aria-label="Volume" type="range" min="0" max="100" value="0">
<ul id="list"><li draggable="true">Alpha</li><li draggable="true">Beta</li><li draggable="true">Gamma</li></ul>
<script>
const volume = document.getElementById("volume");
const list = document.getElementById("list");
const show = () => {
  document.title = "range " + volume.value + " order " + [...list.children].map((li) => li.textContent[0]).join("");
};
let dragged;
list.addEventListener("dragstart", (e) => { dragged = e.target; e.dataTransfer.setData("text/plain", ""); });
list.addEventListener("dragover", (e) => e.preventDefault());
list.addEventListener("drop", (e) => {
  e.preventDefault();
  const onto = e.target.closest("li");
  if (onto && dragged && onto !== dragged) list.insertBefore(dragged, onto.nextSibling);
  show();
});
volume.addEventListener("input", show);
show();
</script></body></html>`;
    shell(`mkdir -p ${HOME}/eval && cat > ${HOME}/eval/drag.html <<'PAGE'\n${page}\nPAGE`);
    shell("pkill -f [c]hromium; sleep 1; true");
    cell.launch(["/usr/local/bin/localdot-chromium", `file://${HOME}/eval/drag.html`]);
    const browser = await waitFor("the page", titled(/^range \d+ order \w+/), 60_000);
    await sleep(2000);
    // The page's own origin, by its magenta mark in the screenshot (model pixels, one per CSS
    // pixel at 2x), rather than by element boxes.
    const frame = await decodeImage(Buffer.from((await desktop.observe()).image, "base64"));
    const origin = findBlock(frame, [255, 0, 255], { x: 0, y: 0, w: 1280, h: 800 });
    if (!origin) throw new Error("no page origin mark");
    const at = (x: number, y: number) => ({ x: (origin.x + x) * 2, y: (origin.y + y) * 2 });
    const drag = (from: Point, to: Point, durationMs: number, signal?: AbortSignal) =>
      desktop.input(
        {
          input: { kind: "drag", from, to, button: "left", durationMs },
          injector: "xtest",
          holdMs: 0,
          window: browser.id,
          dropWindow: browser.id,
        },
        signal,
      );
    const title = async () => (await titled(/^range \d+ order \w+/)())?.title ?? "";

    // The thumb at 0 is 8 CSS px into the 600 px track; 80% along is about 80.
    await drag(at(108, 120), at(580, 120), 600);
    await sleep(800);
    const value = Number(/range (\d+)/.exec(await title())?.[1]);
    console.log(`range after the drag: ${value}`);
    expect(value).toBeGreaterThanOrEqual(70);
    expect(value).toBeLessThanOrEqual(90);

    const [alpha, gamma] = [at(250, 280), at(250, 420)];
    const stop = new AbortController();
    const stopping = drag(alpha, gamma, 4000, stop.signal).catch((e: unknown) => e);
    await sleep(2500);
    stop.abort();
    expect(await stopping).toBeInstanceOf(Error);
    await desktop.release();
    await sleep(1000);
    expect(await title()).toMatch(/ order ABG/);
    expect(nothingDown()).toEqual({ keys: [], buttons: 0 });

    await drag(alpha, gamma, 900);
    await sleep(800);
    await keep("chromium-drags.png");
    expect(await title()).toMatch(/ order BGA/);
    expect(nothingDown()).toEqual({ keys: [], buttons: 0 });
    shell("pkill -f [c]hromium; true");
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
