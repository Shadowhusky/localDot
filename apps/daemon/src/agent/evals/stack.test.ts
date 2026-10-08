import { describe, expect, it } from "vitest";
import { callsOf, manualInputsFor } from "./stack.ts";

describe("manualInputsFor", () => {
  it("types text and presses Return and Tab as keys", () => {
    expect(manualInputsFor({ action: "type", text: "Pen\t4\n~/a.ods\n" }, 2)).toEqual([
      { kind: "text", text: "Pen" },
      { kind: "key", combo: ["Tab"] },
      { kind: "text", text: "4" },
      { kind: "key", combo: ["Return"] },
      { kind: "text", text: "~/a.ods" },
      { kind: "key", combo: ["Return"] },
    ]);
  });

  it("clicks at the device point and presses keys as given", () => {
    expect(
      manualInputsFor({ action: "click", point: { x: 100, y: 50 }, button: "left", count: 3 }, 2),
    ).toEqual([{ kind: "click", at: { x: 200, y: 100 }, button: "left", count: 3 }]);
    expect(manualInputsFor({ action: "key", keys: ["ctrl", "s"] }, 2)).toEqual([
      { kind: "key", combo: ["ctrl", "s"] },
    ]);
    expect(manualInputsFor({ action: "screenshot" }, 2)).toEqual([]);
    expect(manualInputsFor(undefined, 2)).toEqual([]);
  });
});

describe("callsOf", () => {
  const result = (toolName: string, type: string, value: string) => ({
    type: "tool-result",
    toolCallId: "c",
    toolName,
    output: { type, value },
  });

  it("separates refused and failed calls from skipped ones", () => {
    expect(
      callsOf([
        { role: "user", content: "task" },
        {
          role: "tool",
          content: [
            result("computer", "error-text", "mouse_move is not supported yet"),
            result("computer", "error-text", "Skipped: an earlier action in this batch failed."),
          ],
        },
        { role: "tool", content: [result("done", "text", "Task finished.")] },
      ]),
    ).toEqual([
      { name: "computer", ok: false, skipped: false, refused: true },
      { name: "computer", ok: false, skipped: true, refused: false },
      { name: "done", ok: true, skipped: false, refused: false },
    ]);
  });
});
