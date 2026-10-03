import { describe, expect, it } from "vitest";
import { keyCombo, toComputerAction } from "./computer.ts";

const F = "01JXYZ0000000000000000FRAM";

describe("toComputerAction", () => {
  it("maps Anthropic's clicks, with the basis frame", () => {
    expect(
      toComputerAction({ action: "double_click", coordinate: [100, 200] }, "pixels", F),
    ).toEqual({
      action: "click",
      point: { x: 100, y: 200 },
      button: "left",
      count: 2,
      basedOn: F,
    });
    expect(
      toComputerAction({ action: "right_click", coordinate: [5, 6] }, "pixels", undefined),
    ).toEqual({
      action: "click",
      point: { x: 5, y: 6 },
      button: "right",
      count: 1,
    });
  });

  it("maps keys, typing, scrolling, waiting and zooming", () => {
    expect(
      toComputerAction({ action: "key", text: "ctrl+shift+t", repeat: 2 }, "pixels", F),
    ).toEqual({ action: "key", keys: ["ctrl", "shift", "t"], repeat: 2 });
    expect(toComputerAction({ action: "type", text: "hello" }, "pixels", F)).toEqual({
      action: "type",
      text: "hello",
    });
    expect(
      toComputerAction(
        {
          action: "scroll",
          coordinate: [500, 500],
          scroll_direction: "up",
          scroll_amount: 5,
        },
        "per1000",
        F,
      ),
    ).toEqual({
      action: "scroll",
      point: { x: 640, y: 400 },
      dx: 0,
      dy: -5,
      basedOn: F,
    });
    expect(toComputerAction({ action: "wait", duration: 90 }, "pixels", F)).toEqual({
      action: "wait",
      ms: 30_000,
    });
    expect(toComputerAction({ action: "zoom", region: [100, 100, 300, 200] }, "pixels", F)).toEqual(
      { action: "zoom", region: { x: 100, y: 100, w: 200, h: 100 } },
    );
  });

  it("refuses what the gateway cannot do yet, and malformed actions, with a message for the model", () => {
    for (const input of [
      {
        action: "left_click_drag",
        start_coordinate: [1, 1],
        coordinate: [2, 2],
      },
      { action: "mouse_move", coordinate: [1, 1] },
      { action: "left_click" },
      { action: "left_click", coordinate: [10, 10], text: "shift" },
      { action: "zoom", region: [300, 300, 100, 100] },
      { action: "key" },
      { action: "teleport" },
    ]) {
      expect(typeof toComputerAction(input, "pixels", F), JSON.stringify(input)).toBe("string");
    }
  });

  it("splits key combos and refuses empty ones", () => {
    expect(keyCombo("Return")).toEqual(["Return"]);
    expect(keyCombo("+")).toBeUndefined();
  });
});

it("refuses malformed provider values and inherited names without emitting an action", () => {
  for (const input of [
    null,
    { action: "constructor", coordinate: [1, 1] },
    { action: "__proto__", coordinate: [1, 1] },
    { action: "wait", duration: NaN },
    { action: "key", text: "x", repeat: 1.5 },
    { action: "type", text: 42 },
    { action: "scroll", coordinate: [1, 1], scroll_direction: "diagonal" },
    { action: "key", text: "ctrl++x" },
  ]) {
    expect(typeof toComputerAction(input as never, "pixels", F)).toBe("string");
  }
});
