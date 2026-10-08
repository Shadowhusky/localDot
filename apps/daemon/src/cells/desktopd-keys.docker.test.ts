import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EvalCell,
  evalCellOptions,
  removeEvalContainers,
  startEvalCell,
} from "../agent/evals/cell.ts";
import { oracleModel, type Policy } from "../agent/evals/oracle.ts";
import { key, scripted, windowTitled } from "../agent/evals/policy.ts";
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
const SHIFT_L = 50;

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

function python(script: string): string {
  const r = cell.exec(["/usr/bin/python3", "-c", script]);
  if (r.status !== 0) throw new Error(`python in the cell failed: ${r.err}`);
  return r.out.trim();
}

// The keys and buttons the X server has down, read in the cell (a test-side check only).
function down(): { keys: number[]; buttons: number } {
  return JSON.parse(
    python(
      [
        "import json",
        "from Xlib import display",
        "d = display.Display()",
        "km = d.query_keymap()",
        "keys = [i * 8 + b for i, byte in enumerate(km) for b in range(8) if byte >> b & 1]",
        "mask = d.screen().root.query_pointer().mask",
        "print(json.dumps({'keys': keys, 'buttons': mask & 0x1f00}))",
      ].join("\n"),
    ),
  );
}

function press(combo: string[], more: { repeat?: number; window?: number } = {}) {
  return desktop.input({
    input: { kind: "key", combo, ...(more.repeat ? { repeat: more.repeat } : {}) },
    injector: "xtest",
    holdMs: 0,
    ...(more.window ? { window: more.window } : {}),
  });
}

// GIMP's paint tool size, read over AT-SPI: the first spin button that has a reset button and a
// link toggle beside it in the tool options (the spin buttons there carry no names).
function brushSize(): number {
  return Number(
    python(
      [
        "import gi",
        "gi.require_version('Atspi', '2.0')",
        "from gi.repository import Atspi",
        "def walk(n, depth=0):",
        "    for i in range(min(n.get_child_count(), 400)):",
        "        c = n.get_child_at_index(i)",
        "        if c is None: continue",
        "        if c.get_role_name() == 'spin button':",
        "            p = c.get_parent()",
        "            roles = [p.get_child_at_index(j).get_role_name() for j in range(p.get_child_count())]",
        "            if roles[:3] == ['spin button', 'button', 'toggle button']:",
        "                print(Atspi.Value.get_current_value(c)); return True",
        "        if depth < 40 and walk(c, depth + 1): return True",
        "    return False",
        "d = Atspi.get_desktop(0)",
        "for i in range(d.get_child_count()):",
        "    a = d.get_child_at_index(i)",
        "    if a is not None and 'gimp' in (a.get_name() or '').lower() and walk(a): break",
      ].join("\n"),
    ),
  );
}

const oracle = (policy: Policy) => (facts: Parameters<typeof oracleModel>[1]) => ({
  binding: ORACLE_BINDING,
  model: oracleModel(policy, facts).model,
});

describe.skipIf(!DOCKER_TESTS)("keyboard input on a real 2× desktop", () => {
  beforeAll(async () => {
    if (!options) return;
    cell = await startEvalCell("keys", options);
    desktop = new DesktopdClient({ baseUrl: cell.baseUrl, token: cell.token });
  });
  afterAll(() => {
    if (options && cell) removeEvalContainers(options, cell.name);
  });

  it("types what every key name in the matrix stands for, in Mousepad", async () => {
    cell.write(`${HOME}/eval/keys.txt`, "");
    cell.launch(["mousepad", `${HOME}/eval/keys.txt`]);
    const editor = await waitFor("Mousepad", titled(/keys\.txt - Mousepad$/), 60_000);
    await sleep(1500);
    const matrix: { keys: (string[] | { combo: string[]; repeat: number })[]; text: RegExp }[] = [
      { keys: [["plus"], ["minus"], ["equal"]], text: /^\+-=$/ },
      {
        keys: [["bracketleft"], ["bracketright"], ["braceleft"], ["BRACERIGHT"]],
        text: /^\[\]\{\}$/,
      },
      { keys: [["asciitilde"], ["~"], ["?"], ["question"], ["shift", "1"]], text: /^~~\?\?!$/ },
      {
        keys: [["quotedbl"], ["at"], ["numbersign"], ["percent"], ["underscore"], ["bar"]],
        text: /^"@#%_\|$/,
      },
      { keys: [["less"], ["greater"], ["colon"], ["ampersand"], ["asterisk"]], text: /^<>:&\*$/ },
      { keys: [["KP_1"], ["KP_Decimal"], ["kp_5"]], text: /^1\.5$/ },
      { keys: [["KP_Add"], ["KP_Multiply"], ["KP_Subtract"], ["KP_Divide"]], text: /^\+\*-\/$/ },
      { keys: [["x"], ["KP_Enter"], ["y"], ["Return"], ["z"], ["Tab"]], text: /^x\ny\nz\t$/ },
      { keys: [{ combo: ["a"], repeat: 5 }], text: /^aaaaa$/ },
      { keys: [["Caps_Lock"], ["b"], ["Caps_Lock"], ["b"]], text: /^Bb$/ },
      { keys: [["x"], ["Return"], ["y"], ["Page_Up"], ["1"]], text: /^[^\n]*1[^\n]*\ny$/ },
      { keys: [["F13"], ["F24"], ["ctrl", "+"], ["ctrl", "-"], ["Escape"]], text: /^$/ },
      { keys: [["e"], ["BackSpace"], ["f"], ["Left"], ["Delete"]], text: /^$/ },
    ];
    const misses: string[] = [];
    for (const [i, entry] of matrix.entries()) {
      await press(["ctrl", "a"], { window: editor.id });
      await press(["Delete"], { window: editor.id });
      let error = "";
      for (const k of entry.keys) {
        const combo = Array.isArray(k) ? k : k.combo;
        const repeat = Array.isArray(k) ? undefined : k.repeat;
        try {
          await press(combo, { window: editor.id, ...(repeat ? { repeat } : {}) });
        } catch (e) {
          error = `${combo.join("+")}: ${e instanceof Error ? e.message : String(e)}`;
          break;
        }
      }
      // Mousepad's own zoom (ctrl++, ctrl+-) has no text to read; the file shows the rest.
      await press(["ctrl", "s"], { window: editor.id });
      let text = "";
      for (let t = 0; t < 10; t++) {
        await sleep(300);
        text = cell.read(`${HOME}/eval/keys.txt`)?.toString("utf8") ?? "";
        if (entry.text.test(text)) break;
      }
      if (error || !entry.text.test(text))
        misses.push(`#${i} ${JSON.stringify(entry.keys)} -> ${JSON.stringify(text)} ${error}`);
    }
    console.log(misses.length ? `misses:\n${misses.join("\n")}` : "every key typed as named");
    expect(misses).toEqual([]);
    expect(down().keys).toEqual([]);
    cell.exec(["pkill", "mousepad"]);
  });

  it("holds keys while asked, and lets go of them when the request is stopped", async () => {
    const stop = new AbortController();
    const holding = desktop
      .input(
        { input: { kind: "key", combo: ["shift"], holdMs: 20_000 }, injector: "xtest", holdMs: 0 },
        stop.signal,
      )
      .catch((e: unknown) => e);
    await sleep(1500);
    expect(down().keys).toContain(SHIFT_L);
    stop.abort();
    await holding;
    await sleep(500);
    expect(down()).toEqual({ keys: [], buttons: 0 });

    const started = performance.now();
    await desktop.input({
      input: { kind: "key", combo: ["shift"], holdMs: 1000 },
      injector: "xtest",
      holdMs: 0,
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(1000);
    expect(down().keys).toEqual([]);
  });

  it("releases the keys a helper held when it died", async () => {
    const holding = desktop
      .input({
        input: { kind: "key", combo: ["shift"], holdMs: 20_000 },
        injector: "xtest",
        holdMs: 0,
      })
      .catch((e: unknown) => e);
    await sleep(1500);
    expect(down().keys).toContain(SHIFT_L);
    cell.exec(["pkill", "-KILL", "-f", "xhelper.py"]);
    await holding;
    // desktopd starts a new helper within 2 s, and the new one releases what the old one held.
    await waitFor(
      "a new helper",
      async () => ((await desktop.clock()) && down().keys.length === 0 ? true : undefined),
      15_000,
    );
    expect(down()).toEqual({ keys: [], buttons: 0 });
  });

  it("presses ] five times as one approved input in GIMP, growing the brush without a pause", async () => {
    cell.exec(["mkdir", "-p", `${HOME}/eval`]);
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
    cell.launch(["gimp", `${HOME}/eval/canvas.png`]);
    const image = /^\[canvas\].*GIMP$/;
    await waitFor("GIMP", titled(image), 180_000);
    await sleep(2000);
    // GIMP greets its first start with a dialog over the image window: its Close button.
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
    const before = brushSize();
    const grow = { name: "grow the brush", act: () => [key("]", 5)] };
    const run = await runAgent({
      cell,
      home: mkdtempSync(join(tmpdir(), "localdot-keys-")),
      task: "Make the paintbrush 15 pixels bigger with the ] key.",
      model: oracle(
        scripted(
          [
            { ...grow, ready: (v) => !!windowTitled(v, image) && !windowTitled(v, /^Welcome/) },
            grow,
            grow,
          ],
          "Grew the brush.",
        ),
      ),
      timeoutMs: 180_000,
    });
    expect(run.error).toBeUndefined();
    expect(run.outcome).toBe("done");
    expect(run.events.filter((e) => e.type === "safety.pause")).toEqual([]);
    expect(run.events.filter((e) => e.type === "action.dispatch")).toHaveLength(3);
    expect(brushSize()).toBe(before + 15);
  });

  it("lets go of held keys when the agent stops in the middle of a hold", async () => {
    const running = runAgent({
      cell,
      home: mkdtempSync(join(tmpdir(), "localdot-keys-")),
      task: "Hold Shift for 25 seconds.",
      model: oracle(() => [["computer", { action: "hold_key", text: "shift", duration: 25 }]]),
      timeoutMs: 6000,
    });
    await sleep(4000);
    expect(down().keys).toContain(SHIFT_L);
    const run = await running;
    expect(run.outcome).toBe("timeout");
    expect(down()).toEqual({ keys: [], buttons: 0 });
  });
});
