import type { ComputerAction, ToolName } from "@localdot/protocol";
import type { NativeActionIdentity } from "../../../gateway/gateway.ts";

// The approval cards and hand-offs of a real "draw it by hand" task, rebuilt as generic action
// shapes: the commands, paths and points are stand-ins, not the task's own text. The paint app had
// no accessibility tree, so every pointer and keyboard target was a bare coordinate.
export type EvidenceRow =
  | { id: string; kind: "tool"; tool: ToolName; input: Record<string, unknown> }
  | { id: string; kind: "native"; action: ComputerAction; identity: NativeActionIdentity }
  | { id: string; kind: "model"; tool: ToolName; input: Record<string, unknown> };

const at = (x: number, y: number): NativeActionIdentity => ({
  target: null,
  window: 7,
  point: { x, y },
});
const click = (id: string, x: number, y: number, count: 1 | 2 | 3 = 1): EvidenceRow => ({
  id,
  kind: "native",
  action: { action: "click", point: { x, y }, ...(count > 1 ? { count } : {}) },
  identity: at(x, y),
});
const key = (id: string, keys: string[]): EvidenceRow => ({
  id,
  kind: "native",
  action: { action: "key", keys },
  identity: { target: null, window: 7, point: null },
});
const type = (id: string, text: string): EvidenceRow => ({
  id,
  kind: "native",
  action: { action: "type", text },
  identity: { target: null, window: 7, point: null },
});
const shell = (id: string, command: string): EvidenceRow => ({
  id,
  kind: "tool",
  tool: "shell",
  input: { command },
});

export const MANUAL_DRAWING_TASK: readonly EvidenceRow[] = [
  shell("1", 'python3 -c "import sys; print(sys.version)"; which convert inkscape'),
  { id: "2", kind: "tool", tool: "files", input: { op: "write", path: "sketch.py", content: "x" } },
  shell("3", "cd ~ && python3 sketch.py && ls -la sketch.png"),
  shell("4", "(eog sketch.png &); sleep 2"),
  shell("5", "(xdg-open sketch.png &); sleep 3"),
  {
    id: "6",
    kind: "tool",
    tool: "files",
    input: { op: "edit", path: "sketch.py", old_text: "x", new_text: "y" },
  },
  {
    id: "7",
    kind: "tool",
    tool: "files",
    input: { op: "edit", path: "sketch.py", old_text: "y", new_text: "z" },
  },
  shell(
    "8",
    "for a in gimp krita mypaint; do command -v $a && echo found $a; done; ls /usr/share/applications | head -40",
  ),
  shell("9", "(gimp >/tmp/paint.log 2>&1 &); sleep 20"),
  shell("10", "sleep 15; tail -5 /tmp/paint.log; pgrep -a gimp"),
  click("11", 626, 640),
  click("12", 626, 640),
  click("13", 34, 67),
  click("14", 53, 98),
  click("15", 562, 359, 3),
  type("H1", "a1b"),
  click("16", 85, 262),
  click("17", 85, 262, 2),
  click("18", 400, 364, 3),
  click("19", 431, 363, 3),
  type("H2", "c0ffee"),
  type("H3", "c0ffee"),
  click("20", 85, 262),
  click("21", 85, 262),
  click("22", 383, 363, 3),
  key("23", ["ctrl", "a"]),
  click("24", 380, 363),
  key("25", ["ctrl", "a"]),
  click("26", 253, 176),
  click("27", 253, 328),
  click("28", 531, 451),
  click("29", 192, 483),
  key("30", ["bracketright"]),
  key("31", ["bracketright"]),
  key("32", ["bracketright"]),
  click("33", 149, 480),
  {
    id: "H4",
    kind: "model",
    tool: "request_takeover",
    input: { reason: "other", note: "Please take over." },
  },
];
