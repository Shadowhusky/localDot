import { describe, expect, it } from "vitest";
import {
  hiddenParts,
  type OwnedWindow,
  WindowOwners,
  type WindowsSnapshot,
} from "./window-owners.ts";

const frame = { x: 0, y: 0, w: 400, h: 300 };
function win(id: number, more: Partial<OwnedWindow> = {}): OwnedWindow {
  return { id, pid: id * 10, frame, active: false, ...more };
}
const at = (ticks: number, windows: OwnedWindow[]): WindowsSnapshot => ({ ticks, windows });

describe("window ownership", () => {
  it("gives a task the windows its own action made, and nobody the desktop's own", () => {
    const owners = new WindowOwners(() => true);
    const desktop = win(1, { started: 0 });
    owners.begin("a", at(100, [desktop]));
    owners.end("a", at(120, [win(2, { started: 110, active: true }), desktop]));
    expect(owners.ownerOf(1)).toBeUndefined();
    expect(owners.ownerOf(2)).toBe("a");
    expect(owners.foreign("b", 2)).toBe(true);
    expect(owners.foreign("a", 2)).toBe(false);
    expect(owners.foreign("b", 1)).toBe(false);
  });

  it("gives a slow program's first window to the task that started it, whoever acts when it shows", () => {
    const owners = new WindowOwners(() => true);
    owners.begin("a", at(100, []));
    owners.end("a", at(120, []));
    owners.begin("b", at(130, []));
    owners.end("b", at(150, [win(3, { started: 115 })]));
    expect(owners.ownerOf(3)).toBe("a");
  });

  it("gives a running program's new window to the task acting when it opened", () => {
    const owners = new WindowOwners(() => true);
    owners.begin("a", at(100, []));
    owners.end("a", at(120, [win(4, { pid: 77, started: 110 })]));
    owners.begin("b", at(130, [win(4, { pid: 77, started: 110 })]));
    owners.end(
      "b",
      at(150, [win(5, { pid: 77, started: 110 }), win(4, { pid: 77, started: 110 })]),
    );
    expect(owners.ownerOf(4)).toBe("a");
    expect(owners.ownerOf(5)).toBe("b");
  });

  it("gives a dialog to its parent's task and a shell's program to the shell's task", () => {
    const owners = new WindowOwners(() => true);
    owners.shell("cmd-1", "c");
    owners.begin("a", at(100, []));
    owners.end("a", at(120, [win(6, { started: 110 })]));
    owners.begin("b", at(130, [win(6, { started: 110 })]));
    owners.end(
      "b",
      at(150, [
        win(7, { transientFor: 6 }),
        win(8, { command: "cmd-1", started: 5 }),
        win(6, { started: 110 }),
      ]),
    );
    expect(owners.ownerOf(7)).toBe("a");
    expect(owners.ownerOf(8)).toBe("c");
  });

  it("brings forward the window the task left active, or its topmost one", () => {
    const owners = new WindowOwners(() => true);
    owners.begin("a", at(100, []));
    const windows = [win(9, { started: 110 }), win(10, { started: 111, active: true })];
    owners.end("a", at(120, windows));
    expect(owners.target("a", at(130, windows))).toBe(10);
    expect(owners.target("a", at(130, [win(9, { started: 110 })]))).toBe(9);
    expect(owners.target("b", at(130, windows))).toBeUndefined();
  });

  it("frees an ended task's windows until its conversation goes on, and forgets closed ones", () => {
    const live = new Set(["a", "b"]);
    const owners = new WindowOwners((id) => live.has(id));
    owners.begin("a", at(100, []));
    owners.end("a", at(120, [win(11, { started: 110, active: true })]));
    live.delete("a");
    expect(owners.foreign("b", 11)).toBe(false);
    live.add("a2");
    owners.inherit("a2", "a");
    expect(owners.ownerOf(11)).toBe("a2");
    expect(owners.foreign("b", 11)).toBe(true);
    expect(owners.target("a2", at(130, [win(11, { started: 110 })]))).toBe(11);
    owners.learn(at(140, []));
    expect(owners.ownerOf(11)).toBeUndefined();
  });
});

describe("the parts of the screen a task may not see", () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  it("covers another task's window less what lies above it", () => {
    const windows = [
      { id: 1, frame: box(100, 100, 200, 100) },
      { id: 2, frame: box(0, 0, 400, 300) },
    ];
    const parts = hiddenParts(windows, (id) => id === 2);
    const area = parts.reduce((sum, r) => sum + r.w * r.h, 0);
    expect(area).toBe(400 * 300 - 200 * 100);
    for (const r of parts)
      expect(r.x + r.w <= 100 || r.x >= 300 || r.y + r.h <= 100 || r.y >= 200).toBe(true);
    expect(hiddenParts(windows, (id) => id === 1)).toEqual([box(100, 100, 200, 100)]);
    expect(hiddenParts([{ id: 3, frame: box(0, 0, 10, 10) }, ...windows], () => false)).toEqual([]);
  });
});
