import { readFileSync } from "node:fs";
import { toComputerActions } from "../../../../../cells/brain/src/computer.ts";
import { type EvalCell, waitForWindow } from "./cell.ts";
import {
  decodeImage,
  ellipseVerdict,
  fillVerdict,
  jsonVerdict,
  parseHex,
  placementVerdict,
  tableVerdict,
  textVerdict,
  type Verdict,
} from "./checks.ts";
import { type OracleView, type Policy, pixel } from "./oracle.ts";
import {
  click,
  colourExtent,
  doubleClick,
  drag,
  ellipse,
  findBlock,
  key,
  modifierClick,
  near,
  type Rect,
  type Step,
  scripted,
  stroke,
  tripleClick,
  type,
  wait,
  windowTitled,
} from "./policy.ts";

export type Capability = "drag" | "modifier_click";

export interface EvalTask {
  id: string;
  prompt: string;
  // Capabilities a task cannot pass without; until they land it runs as an expected failure.
  requires: readonly Capability[];
  // The most inputs the simulated user may do for the agent. Today every typed text is handed
  // over; lower this as hand-offs go away, never raise it.
  maxHandoffs: number;
  timeoutMs: number;
  setup(cell: EvalCell): Promise<void>;
  oracle(): Policy;
  check(cell: EvalCell): Promise<Verdict>;
}

// A capability counts as landed once the brain turns its actions into daemon actions.
export function capabilityLanded(capability: Capability): boolean {
  const accepts = (input: Record<string, unknown>) =>
    typeof toComputerActions(input, "pixels", "01M4DAHWJZV7VKKJNW9F0A3WXJ") !== "string";
  if (capability === "modifier_click")
    return accepts({ action: "left_click", coordinate: [10, 10], text: "ctrl" });
  return (
    accepts({ action: "left_click_drag", start_coordinate: [10, 10], coordinate: [20, 20] }) &&
    accepts({ action: "left_mouse_down" }) &&
    accepts({ action: "mouse_move", coordinate: [20, 20] }) &&
    accepts({ action: "left_mouse_up" })
  );
}

const HOME = "/config";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

function listing(cell: EvalCell, dirs: readonly string[]): Record<string, string[] | undefined> {
  return Object.fromEntries(
    dirs.map((dir) => {
      const r = cell.exec(["ls", "-1A", `${HOME}/${dir}`]);
      return [dir, r.status === 0 ? r.out.split("\n").filter(Boolean) : undefined];
    }),
  );
}

async function imageCheck(cell: EvalCell, path: string, judge: typeof ellipseVerdict) {
  const bytes = cell.read(`${HOME}/${path}`);
  if (!bytes) return { ok: false, reasons: [`~/${path} was not saved`] };
  try {
    return judge(await decodeImage(bytes));
  } catch {
    return { ok: false, reasons: [`~/${path} is not an image`] };
  }
}

const textOf = (cell: EvalCell, path: string) => cell.read(`${HOME}/${path}`)?.toString("utf8");

// GIMP's first start in a fresh desktop takes 30-60 s; the task starts once its window is up.
async function startGimp(cell: EvalCell): Promise<void> {
  cell.exec(["mkdir", "-p", `${HOME}/eval`]);
  const made = cell.exec([
    "convert",
    "-size",
    "640x400",
    "xc:white",
    "-strip",
    "-define",
    "png:color-type=2",
    `${HOME}/eval/canvas.png`,
  ]);
  if (made.status !== 0) throw new Error(`could not make the canvas: ${made.err}`);
  cell.launch(["gimp", `${HOME}/eval/canvas.png`]);
  await waitForWindow(cell, (w) => /^\[canvas\].*GIMP$/.test(w.title), 180_000);
}

const gimpMain = (v: OracleView) => windowTitled(v, /GIMP$/);
const WHITE: [number, number, number] = [255, 255, 255];

// The canvas is the white area in the middle of GIMP's main window.
function canvas(v: OracleView): Rect | undefined {
  const main = gimpMain(v);
  if (!v.frame || !main) return undefined;
  const at = findBlock(
    v.frame,
    WHITE,
    { x: main.rect.x + main.rect.w * 0.3, y: main.rect.y + main.rect.h * 0.3, w: 80, h: 80 },
    12,
    2,
  );
  return at ? colourExtent(v.frame, { x: at.x + 6, y: at.y + 6 }, WHITE, 2) : undefined;
}

const fitCanvas: Step = { name: "fit the canvas in the window", act: () => [key("shift+ctrl+j")] };

const closeGimpWelcome: Step = {
  name: "close the welcome dialog",
  ready: (v) => !!gimpMain(v),
  act: (v) => {
    const welcome = windowTitled(v, /^Welcome to GIMP/)?.rect;
    return welcome ? [click(welcome.x + welcome.w - 56, welcome.y + welcome.h - 27)] : [wait(0.5)];
  },
  done: (v) => !windowTitled(v, /^Welcome to GIMP/),
};

function exportGimp(name: string): Step[] {
  return [
    {
      name: "open Export As",
      act: () => [key("ctrl+shift+e")],
      done: (v) => !!windowTitled(v, /^Export Image$/),
    },
    {
      name: "name the export",
      act: () => [key("ctrl+a"), type(`~/eval/${name}\n`)],
      done: (v) => !!windowTitled(v, /^Export Image as PNG$/),
    },
    {
      name: "confirm the PNG options",
      act: () => [key("Return")],
      done: (v) => /\(exported\)/.test(gimpMain(v)?.title ?? ""),
    },
  ];
}

// The ellipse's right edge is read on the canvas it was drawn on: the white area found afterwards
// is cut by the outline itself.
function drawEllipse(): Step {
  let drawn: Rect | undefined;
  return {
    name: "draw the ellipse",
    ready: (v) => !!canvas(v),
    act: (v) => {
      const c = canvas(v) as Rect;
      drawn = c;
      const centre = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
      return stroke(ellipse(centre, c.w * 0.3, c.h * 0.3, 40));
    },
    done: (v) => {
      if (!drawn || !v.frame) return false;
      const [r, g, b] = pixel(v.frame, drawn.x + drawn.w * 0.8, drawn.y + drawn.h / 2);
      return r + g + b < 300;
    },
  };
}

const gimpDrawShape: EvalTask = {
  id: "gimp-draw-shape",
  prompt:
    "GIMP is open with a blank canvas. Draw a closed ellipse outline by hand with the paintbrush, then export the image as ~/eval/shape.png.",
  requires: ["drag"],
  maxHandoffs: 1,
  timeoutMs: 600_000,
  setup: startGimp,
  oracle: () =>
    scripted(
      [
        closeGimpWelcome,
        fitCanvas,
        { name: "pick the paintbrush", act: () => [key("p")] },
        drawEllipse(),
        ...exportGimp("shape.png"),
      ],
      "Drew the ellipse and exported ~/eval/shape.png.",
    ),
  check: (cell) => imageCheck(cell, "eval/shape.png", ellipseVerdict),
};

const BROWN = "#A9743E";
const gimpPickColour: EvalTask = {
  id: "gimp-pick-colour",
  prompt: `GIMP is open with a blank canvas. Set the foreground colour to ${BROWN} by typing it into the colour dialog's hex field, fill the whole canvas with it and export the image as ~/eval/colour.png.`,
  requires: [],
  maxHandoffs: 2,
  timeoutMs: 600_000,
  setup: startGimp,
  oracle: () => {
    const dialog = (v: OracleView) => windowTitled(v, /^Change Foreground Colou?r$/);
    return scripted(
      [
        closeGimpWelcome,
        {
          name: "open the foreground colour",
          ready: (v) => {
            const main = gimpMain(v);
            return (
              !!main && !!v.frame && !!findBlock(v.frame, [0, 0, 0], toolbox(main.rect), 10, 20)
            );
          },
          act: (v) => {
            const main = gimpMain(v);
            const at = findBlock(v.frame as never, [0, 0, 0], toolbox(main?.rect as Rect), 10, 20);
            return [click((at?.x ?? 0) + 8, (at?.y ?? 0) + 8)];
          },
          done: (v) => !!dialog(v),
        },
        // The dialog's right column (hex field, OK) keeps its offset from the right edge
        // whatever width the dialog opens at; the Current swatch starts at the left.
        {
          name: "type the hex value",
          act: (v) => {
            const d = dialog(v)?.rect as Rect;
            return [tripleClick(d.x + d.w - 137, d.y + 257), type(`${BROWN.slice(1)}\n`)];
          },
          done: (v) => {
            const d = dialog(v)?.rect;
            return (
              !!d && !!v.frame && near(pixel(v.frame, d.x + 100, d.y + 278), parseHex(BROWN), 10)
            );
          },
        },
        {
          name: "confirm the colour",
          act: (v) => {
            const d = dialog(v)?.rect as Rect;
            return [click(d.x + d.w - 55, d.y + 340)];
          },
          done: (v) => !dialog(v),
        },
        {
          name: "fill with the foreground colour",
          act: () => [key("ctrl+,")],
          done: (v) => {
            const main = gimpMain(v);
            if (!main || !v.frame) return false;
            const at = { x: main.rect.x + main.rect.w * 0.3, y: main.rect.y + main.rect.h * 0.35 };
            return near(pixel(v.frame, at.x, at.y), parseHex(BROWN), 10);
          },
        },
        ...exportGimp("colour.png"),
      ],
      `Filled the canvas with ${BROWN} and exported ~/eval/colour.png.`,
    );
  },
  check: (cell) => imageCheck(cell, "eval/colour.png", (image) => fillVerdict(image, BROWN)),
};

// GIMP's toolbox: the colour swatches sit under the tool icons in the left dock.
const toolbox = (main: Rect): Rect => ({ x: main.x, y: main.y + 150, w: 190, h: 200 });

const TABLE = [
  ["Item", "Qty", "Price"],
  ["Pen", "4", "1.5"],
  ["Book", "2", "12"],
  ["Lamp", "1", "30"],
  ["Desk", "1", "120"],
];
const ODS_ROWS = `
import json, sys, zipfile
import xml.etree.ElementTree as ET
T = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
O = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"
X = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
with zipfile.ZipFile(sys.argv[1]) as z:
    root = ET.fromstring(z.read("content.xml"))
rows = []
for row in next(root.iter(T + "table")).iter(T + "table-row"):
    cells = []
    for cell in row:
        if cell.tag not in (T + "table-cell", T + "covered-table-cell"):
            continue
        value = cell.get(O + "value")
        text = "\\n".join("".join(p.itertext()) for p in cell.iter(X + "p"))
        repeat = min(int(cell.get(T + "number-columns-repeated", "1")), 64)
        cells.extend([value if value is not None else text] * repeat)
    while cells and cells[-1] == "":
        cells.pop()
    rows.extend([cells] * min(int(row.get(T + "number-rows-repeated", "1")), 64))
while rows and not rows[-1]:
    rows.pop()
print(json.dumps(rows[:64]))
`;

const calcFill: EvalTask = {
  id: "calc-fill",
  prompt: `LibreOffice Calc is open on a new spreadsheet. Enter this table starting at A1, one row per line and columns separated by commas, then save it as ~/eval/table.ods:\n${TABLE.map((r) => r.join(", ")).join("\n")}`,
  requires: [],
  maxHandoffs: 2,
  timeoutMs: 300_000,
  setup: async (cell) => {
    cell.exec(["mkdir", "-p", `${HOME}/eval`]);
    cell.launch(["libreoffice", "--calc", "--norestore"]);
    await waitForWindow(cell, (w) => /LibreOffice Calc$/.test(w.title), 120_000);
  },
  oracle: () =>
    scripted(
      [
        {
          name: "enter the table",
          ready: (v) => !!windowTitled(v, /LibreOffice Calc$/),
          act: () => [key("ctrl+Home"), type(`${TABLE.map((r) => r.join("\t")).join("\n")}\n`)],
        },
        {
          name: "open Save As",
          act: () => [key("ctrl+shift+s")],
          done: (v) => !!windowTitled(v, /^Save$/),
        },
        {
          name: "save as table.ods",
          act: () => [type("~/eval/table.ods\n")],
          done: (v) => !!windowTitled(v, /^table\.ods\b.*LibreOffice Calc$/),
        },
      ],
      "Entered the table and saved ~/eval/table.ods.",
    ),
  check: async (cell) => {
    const r = cell.exec(["python3", "-", `${HOME}/eval/table.ods`], ODS_ROWS);
    if (r.status !== 0) return { ok: false, reasons: ["~/eval/table.ods was not saved"] };
    return tableVerdict(JSON.parse(r.out) as string[][], TABLE);
  },
};

const FORM = {
  name: "Robin Hale",
  country: "Norway",
  leaveAtDoor: true,
  date: "2026-10-08",
  bellVolume: 7,
  packingOrder: ["Cheese", "Apples", "Bread", "Dates"],
};
const FORM_HEADER: [number, number, number] = [59, 91, 219];
// The page's blue header bar anchors every control: the form is laid out in fixed CSS pixels.
function formTop(v: OracleView): number | undefined {
  return v.frame
    ? findBlock(v.frame, FORM_HEADER, { x: 0, y: 40, w: 60, h: 300 }, 8, 6)?.y
    : undefined;
}

const webForm: EvalTask = {
  id: "web-form",
  prompt:
    "Fill in the delivery form open in Chromium: name Robin Hale, country Norway, leave at door ticked, date 8 October 2026, bell volume 7, packing order Cheese, Apples, Bread, Dates. Then submit it.",
  requires: [],
  maxHandoffs: 2,
  timeoutMs: 300_000,
  setup: async (cell) => {
    cell.write(`${HOME}/eval/form.html`, fixture("form.html"));
    cell.launch(["/usr/local/bin/localdot-chromium", `file://${HOME}/eval/form.html`]);
    await waitForWindow(cell, (w) => /^Delivery form - Chromium$/.test(w.title), 120_000);
  },
  oracle: () => {
    const top = (v: OracleView) => formTop(v) as number;
    return scripted(
      [
        {
          name: "type the name",
          ready: (v) => formTop(v) !== undefined,
          act: (v) => [click(400, top(v) + 74), type(FORM.name)],
        },
        { name: "choose the country", act: () => [key("Tab"), key("n")] },
        { name: "tick leave at door", act: () => [key("Tab"), key("space")] },
        { name: "type the date", act: () => [key("Tab"), type("10082026")] },
        { name: "set the bell volume", act: (v) => [click(200 + 8 + 0.7 * 384, top(v) + 282)] },
        {
          name: "move Cheese to the top",
          act: (v) => [click(300, top(v) + 402), key("alt+Up"), key("alt+Up")],
        },
        { name: "submit", act: (v) => [click(280, top(v) + 522)] },
      ],
      "Filled in and submitted the delivery form.",
    );
  },
  check: async (cell) => jsonVerdict(textOf(cell, "Downloads/form.json"), FORM),
};

// Thunar's detailed list: rows 28 px apart under the column header, names in the first column.
const thunarRow = (w: Rect, index: number) => ({ x: w.x + 229, y: w.y + 101 + 28 * index });

async function startThunar(cell: EvalCell, dir: string, title: RegExp): Promise<void> {
  cell.launch(["thunar", `${HOME}/${dir}`]);
  await waitForWindow(cell, (w) => title.test(w.title), 60_000);
}

const filesDragDrop: EvalTask = {
  id: "files-drag-drop",
  prompt:
    "The file manager shows ~/eval/desk. Drag report.txt onto the archive folder to move it there.",
  requires: ["drag"],
  maxHandoffs: 0,
  timeoutMs: 180_000,
  setup: async (cell) => {
    cell.exec(["mkdir", "-p", `${HOME}/eval/desk/archive`]);
    cell.write(`${HOME}/eval/desk/report.txt`, "quarterly numbers\n");
    await startThunar(cell, "eval/desk", /^desk - Thunar$/);
  },
  oracle: () => {
    const win = (v: OracleView) => windowTitled(v, /^desk - Thunar$/)?.rect as Rect;
    return scripted(
      [
        {
          name: "drag report.txt onto archive",
          ready: (v) => !!windowTitled(v, /^desk - Thunar$/),
          act: (v) => {
            const from = thunarRow(win(v), 1);
            const to = thunarRow(win(v), 0);
            return [drag([from.x, from.y], [to.x, to.y])];
          },
        },
      ],
      "Moved report.txt into archive.",
    );
  },
  check: async (cell) =>
    placementVerdict(listing(cell, ["eval/desk", "eval/desk/archive"]), [
      { dir: "eval/desk/archive", has: ["report.txt"], lacks: [] },
      { dir: "eval/desk", has: ["archive"], lacks: ["report.txt"] },
    ]),
};

const INBOX = ["1-alpha.txt", "2-beta.txt", "3-gamma.txt", "4-delta.txt", "5-epsilon.txt"];
const filesMultiSelect: EvalTask = {
  id: "files-multi-select",
  prompt:
    "The file manager shows ~/eval/inbox. Select 2-beta.txt to 4-delta.txt with click and Shift+click, add 5-epsilon.txt with Ctrl+click, then move the selection into the done folder.",
  requires: ["modifier_click"],
  maxHandoffs: 0,
  timeoutMs: 180_000,
  setup: async (cell) => {
    cell.exec(["mkdir", "-p", `${HOME}/eval/inbox/done`]);
    for (const name of INBOX) cell.write(`${HOME}/eval/inbox/${name}`, `${name}\n`);
    await startThunar(cell, "eval/inbox", /^inbox - Thunar$/);
  },
  oracle: () => {
    const win = (v: OracleView) => windowTitled(v, /^(inbox|done) - Thunar$/)?.rect as Rect;
    const row = (v: OracleView, i: number) => thunarRow(win(v), i);
    return scripted(
      [
        {
          name: "select 2-beta.txt",
          ready: (v) => !!windowTitled(v, /^inbox - Thunar$/),
          act: (v) => [click(row(v, 2).x, row(v, 2).y)],
        },
        {
          name: "extend to 4-delta.txt",
          act: (v) => [modifierClick(row(v, 4).x, row(v, 4).y, "shift")],
        },
        {
          name: "add 5-epsilon.txt",
          act: (v) => [modifierClick(row(v, 5).x, row(v, 5).y, "ctrl")],
        },
        { name: "cut the selection", act: () => [key("ctrl+x")] },
        {
          name: "open done",
          act: (v) => [doubleClick(row(v, 0).x, row(v, 0).y)],
          done: (v) => !!windowTitled(v, /^done - Thunar$/),
        },
        { name: "paste", act: () => [key("ctrl+v")] },
      ],
      "Moved four files into done.",
    );
  },
  check: async (cell) =>
    placementVerdict(listing(cell, ["eval/inbox", "eval/inbox/done"]), [
      { dir: "eval/inbox/done", has: INBOX.slice(1), lacks: [] },
      { dir: "eval/inbox", has: ["1-alpha.txt"], lacks: INBOX.slice(1) },
    ]),
};

const NOTES = "The quick brown fox\nA fox jumps over the lazy dog\n";
const textKeyboard: EvalTask = {
  id: "text-keyboard",
  prompt:
    "Mousepad is open on ~/eval/notes.txt. Using Find and Replace (Ctrl+R), replace every 'fox' with 'cat'. Then delete the last word of the second line, 'dog', keeping the space before it, and save the file.",
  requires: [],
  maxHandoffs: 2,
  timeoutMs: 300_000,
  setup: async (cell) => {
    cell.write(`${HOME}/eval/notes.txt`, NOTES);
    cell.launch(["mousepad", `${HOME}/eval/notes.txt`]);
    await waitForWindow(cell, (w) => /notes\.txt - Mousepad$/.test(w.title), 60_000);
  },
  oracle: () => {
    const dialog = (v: OracleView) => windowTitled(v, /^Find and Replace$/);
    const at = (v: OracleView, dx: number, dy: number) => {
      const d = dialog(v)?.rect as Rect;
      return click(d.x + dx, d.y + dy);
    };
    return scripted(
      [
        {
          name: "open Find and Replace",
          ready: (v) => !!windowTitled(v, /notes\.txt - Mousepad$/),
          act: () => [key("ctrl+r")],
          done: (v) => !!dialog(v),
        },
        { name: "type the search", act: () => [type("fox")] },
        { name: "type the replacement", act: () => [key("Tab"), type("cat")] },
        {
          name: "replace in the whole document",
          act: (v) => [at(v, 22, 198)],
          done: (v) => {
            const d = dialog(v)?.rect;
            if (!d || !v.frame) return false;
            const [r, , b] = pixel(v.frame, d.x + 22, d.y + 198);
            return b > 150 && r < 120;
          },
        },
        // Mousepad 0.7 replaces one match per Replace All; the document holds two.
        { name: "replace all", act: (v) => [at(v, 276, 236)] },
        { name: "replace the rest", act: (v) => [at(v, 276, 236)] },
        { name: "close the dialog", act: (v) => [at(v, 394, 236)], done: (v) => !dialog(v) },
        {
          name: "delete the last word of the second line",
          act: () => [key("ctrl+Home"), key("Down"), key("End"), key("BackSpace", 3)],
        },
        {
          name: "save",
          act: () => [key("ctrl+s")],
          done: (v) => windowTitled(v, /notes\.txt - Mousepad$/)?.title.startsWith("*") === false,
        },
      ],
      "Replaced every fox with cat, deleted the last word and saved.",
    );
  },
  check: async (cell) =>
    textVerdict(
      textOf(cell, "eval/notes.txt"),
      NOTES.replaceAll("fox", "cat").replace("lazy dog", "lazy "),
    ),
};

export const TASKS: readonly EvalTask[] = [
  gimpDrawShape,
  gimpPickColour,
  calcFill,
  webForm,
  filesDragDrop,
  filesMultiSelect,
  textKeyboard,
];

export const noopPolicy: Policy = () => [["done", { summary: "Nothing to do." }]];
