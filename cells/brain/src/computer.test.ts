import { describe, expect, it } from "vitest";
import { keyCombo, toComputerActions } from "./computer.ts";

const F = "01JXYZ0000000000000000FRAM";

describe("toComputerActions", () => {
  it("maps Anthropic's clicks, with the basis frame", () => {
    expect(
      toComputerActions({ action: "double_click", coordinate: [100, 200] }, "pixels", F),
    ).toEqual([
      {
        action: "click",
        point: { x: 100, y: 200 },
        button: "left",
        count: 2,
        basedOn: F,
      },
    ]);
    expect(
      toComputerActions({ action: "right_click", coordinate: [5, 6] }, "pixels", undefined),
    ).toEqual([
      {
        action: "click",
        point: { x: 5, y: 6 },
        button: "right",
        count: 1,
      },
    ]);
  });

  it("maps keys, typing, scrolling, waiting and zooming", () => {
    expect(
      toComputerActions({ action: "key", text: "ctrl+shift+t", repeat: 2 }, "pixels", F),
    ).toEqual([{ action: "key", keys: ["ctrl", "shift", "t"], repeat: 2 }]);
    expect(toComputerActions({ action: "type", text: "hello" }, "pixels", F)).toEqual([
      { action: "type", text: "hello" },
    ]);
    expect(
      toComputerActions(
        {
          action: "scroll",
          coordinate: [500, 500],
          scroll_direction: "up",
          scroll_amount: 5,
        },
        "per1000",
        F,
      ),
    ).toEqual([
      {
        action: "scroll",
        point: { x: 640, y: 400 },
        dx: 0,
        dy: -5,
        basedOn: F,
      },
    ]);
    expect(toComputerActions({ action: "wait", duration: 90 }, "pixels", F)).toEqual([
      { action: "wait", ms: 30_000 },
    ]);
    expect(
      toComputerActions({ action: "zoom", region: [100, 100, 300, 200] }, "pixels", F),
    ).toEqual([{ action: "zoom", region: { x: 100, y: 100, w: 200, h: 100 } }]);
  });

  it("repeats a key up to 100 times as one action", () => {
    expect(toComputerActions({ action: "key", text: "]", repeat: 5 }, "pixels", F)).toEqual([
      { action: "key", keys: ["]"], repeat: 5 },
    ]);
    expect(toComputerActions({ action: "key", text: "Down", repeat: 100 }, "pixels", F)).toEqual([
      { action: "key", keys: ["Down"], repeat: 100 },
    ]);
    expect(
      typeof toComputerActions({ action: "key", text: "Down", repeat: 101 }, "pixels", F),
    ).toBe("string");
  });

  it("holds keys for up to 30 seconds", () => {
    expect(
      toComputerActions({ action: "hold_key", text: "shift", duration: 1.5 }, "pixels", F),
    ).toEqual([{ action: "hold_key", keys: ["shift"], ms: 1500 }]);
    expect(
      toComputerActions({ action: "hold_key", text: "ctrl+alt", duration: 30 }, "pixels", F),
    ).toEqual([{ action: "hold_key", keys: ["ctrl", "alt"], ms: 30_000 }]);
    for (const input of [
      { action: "hold_key", text: "shift" },
      { action: "hold_key", text: "shift", duration: 0 },
      { action: "hold_key", text: "shift", duration: 31 },
      { action: "hold_key", duration: 1 },
    ])
      expect(typeof toComputerActions(input, "pixels", F), JSON.stringify(input)).toBe("string");
  });

  it("expands typing at a point, clearing the field first and submitting after, in order", () => {
    expect(
      toComputerActions(
        { action: "type", text: "A9743E", coordinate: [431, 363], clear: true, submit: true },
        "pixels",
        F,
      ),
    ).toEqual([
      { action: "click", point: { x: 431, y: 363 }, button: "left", count: 1, basedOn: F },
      { action: "key", keys: ["ctrl", "a"] },
      { action: "key", keys: ["BackSpace"] },
      { action: "type", text: "A9743E" },
      { action: "key", keys: ["Return"] },
    ]);
    expect(toComputerActions({ action: "type", text: "cat", submit: true }, "pixels", F)).toEqual([
      { action: "type", text: "cat" },
      { action: "key", keys: ["Return"] },
    ]);
    expect(toComputerActions({ action: "type", text: "", clear: true }, "pixels", F)).toEqual([
      { action: "key", keys: ["ctrl", "a"] },
      { action: "key", keys: ["BackSpace"] },
    ]);
  });

  it("names the close matches of a key it does not know", () => {
    expect(toComputerActions({ action: "key", text: "ctrl+PageUpp" }, "pixels", F)).toMatch(
      /unknown key "PageUpp"; did you mean/,
    );
    expect(
      toComputerActions({ action: "hold_key", text: "shfit", duration: 1 }, "pixels", F),
    ).toMatch(/unknown key "shfit"; did you mean .*shift/);
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
      { action: "type" },
      { action: "type", text: "x", coordinate: [5000, 5] },
      { action: "teleport" },
    ]) {
      expect(typeof toComputerActions(input, "pixels", F), JSON.stringify(input)).toBe("string");
    }
  });
});

describe("keyCombo", () => {
  it("splits combos on + and reads a trailing + as the plus key", () => {
    expect(keyCombo("Return")).toEqual(["Return"]);
    expect(keyCombo("ctrl+shift+t")).toEqual(["ctrl", "shift", "t"]);
    expect(keyCombo(" ctrl + s ")).toEqual(["ctrl", "s"]);
    expect(keyCombo("ctrl++")).toEqual(["ctrl", "+"]);
    expect(keyCombo("ctrl+shift++")).toEqual(["ctrl", "shift", "+"]);
    expect(keyCombo("+")).toEqual(["+"]);
    expect(keyCombo("ctrl+-")).toEqual(["ctrl", "-"]);
    expect(keyCombo("ctrl+minus")).toEqual(["ctrl", "minus"]);
  });

  it("refuses empty keys and combos it cannot read", () => {
    for (const text of ["", "ctrl+", "ctrl++x", "+ctrl", "a+b+c+d+e+f+g+h+i"])
      expect(keyCombo(text), text).toBeUndefined();
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
    { action: "type", text: "x", clear: "yes" },
    { action: "scroll", coordinate: [1, 1], scroll_direction: "diagonal" },
    { action: "key", text: "ctrl++x" },
  ]) {
    expect(typeof toComputerActions(input as never, "pixels", F)).toBe("string");
  }
});
