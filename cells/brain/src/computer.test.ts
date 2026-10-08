import { describe, expect, it } from "vitest";
import { keyCombo, type ProviderComputerInput, toComputerActions } from "./computer.ts";

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

  it("holds modifier keys through clicks and scrolls, and acts where the cursor is without a point", () => {
    expect(
      toComputerActions(
        { action: "left_click", coordinate: [10, 10], text: "ctrl+shift" },
        "pixels",
        F,
      ),
    ).toEqual([
      {
        action: "click",
        point: { x: 10, y: 10 },
        button: "left",
        count: 1,
        mods: ["ctrl", "shift"],
        basedOn: F,
      },
    ]);
    expect(toComputerActions({ action: "triple_click" }, "pixels", F)).toEqual([
      { action: "click", button: "left", count: 3, basedOn: F },
    ]);
    expect(
      toComputerActions(
        { action: "scroll", scroll_direction: "down", scroll_amount: 2, text: "ctrl" },
        "pixels",
        F,
      ),
    ).toEqual([{ action: "scroll", dx: 0, dy: 2, mods: ["ctrl"], basedOn: F }]);
    expect(
      toComputerActions({ action: "right_click", coordinate: [1, 1], text: "ctrl+a" }, "pixels", F),
    ).toBe('right_click: "a" is not a modifier key; hold shift, ctrl, alt or super');
  });

  it("drags from start to end or along a path, on either grid, with keys, button and time", () => {
    expect(
      toComputerActions(
        {
          action: "left_click_drag",
          start_coordinate: [10, 20],
          coordinate: [300, 400],
          text: "shift",
        },
        "pixels",
        F,
      ),
    ).toEqual([
      {
        action: "drag",
        path: [
          { x: 10, y: 20 },
          { x: 300, y: 400 },
        ],
        button: "left",
        mods: ["shift"],
        basedOn: F,
      },
    ]);
    expect(
      toComputerActions(
        {
          action: "left_click_drag",
          path: [
            [0, 0],
            [500, 500],
            [1000, 1000],
          ],
          button: "middle",
          duration: 1.5,
        },
        "per1000",
        undefined,
      ),
    ).toEqual([
      {
        action: "drag",
        path: [
          { x: 0, y: 0 },
          { x: 640, y: 400 },
          { x: 1279, y: 799 },
        ],
        button: "middle",
        ms: 1500,
      },
    ]);
    const points = (n: number) => Array.from({ length: n }, (_, i) => [i, i]);
    expect(
      toComputerActions({ action: "left_click_drag", path: points(64) }, "pixels", F),
    ).toHaveLength(1);
    for (const n of [1, 65])
      expect(toComputerActions({ action: "left_click_drag", path: points(n) }, "pixels", F)).toBe(
        "left_click_drag: a path has 2 to 64 points",
      );
    for (const input of [
      { action: "left_click_drag", path: points(65) },
      { action: "left_click_drag", path: points(1) },
      { action: "left_click_drag", coordinate: [5, 5] },
      {
        action: "left_click_drag",
        path: [
          [1, 1],
          [2000, 1],
        ],
      },
      {
        action: "left_click_drag",
        path: [
          [1, 1],
          [2, 2],
        ],
        duration: 11,
      },
      {
        action: "left_click_drag",
        path: [
          [1, 1],
          [2, 2],
        ],
        text: "x",
      },
    ])
      expect(typeof toComputerActions(input, "pixels", F), JSON.stringify(input)).toBe("string");
    expect(
      toComputerActions(
        {
          action: "left_click_drag",
          path: [
            [1, 1],
            [1001, 1],
          ],
        },
        "per1000",
        F,
      ),
    ).toBe("left_click_drag: point 2: coordinate (1001, 1) is outside the 0–1000 grid");
  });

  it("moves the cursor, and presses and releases a button where it is or at a point", () => {
    expect(
      toComputerActions({ action: "mouse_move", coordinate: [500, 250] }, "per1000", F),
    ).toEqual([{ action: "move", point: { x: 640, y: 200 }, basedOn: F }]);
    expect(toComputerActions({ action: "left_mouse_down" }, "pixels", F)).toEqual([
      { action: "mouse_down", button: "left", basedOn: F },
    ]);
    expect(
      toComputerActions(
        { action: "left_mouse_down", coordinate: [7, 8], text: "shift", button: "right" },
        "pixels",
        F,
      ),
    ).toEqual([
      { action: "mouse_down", point: { x: 7, y: 8 }, button: "right", mods: ["shift"], basedOn: F },
    ]);
    expect(toComputerActions({ action: "left_mouse_up", coordinate: [9, 9] }, "pixels", F)).toEqual(
      [{ action: "mouse_up", point: { x: 9, y: 9 }, button: "left", basedOn: F }],
    );
    expect(typeof toComputerActions({ action: "left_mouse_up", text: "shift" }, "pixels", F)).toBe(
      "string",
    );
    expect(typeof toComputerActions({ action: "mouse_move" }, "pixels", F)).toBe("string");
  });

  it("accepts every member of the native computer toolset", () => {
    const members: Record<string, Record<string, unknown>> = {
      screenshot: {},
      zoom: { region: [0, 0, 10, 10] },
      left_click: { coordinate: [1, 1] },
      right_click: {},
      middle_click: { coordinate: [1, 1] },
      double_click: { coordinate: [1, 1], text: "alt" },
      triple_click: { coordinate: [1, 1] },
      left_click_drag: { start_coordinate: [1, 1], coordinate: [9, 9] },
      mouse_move: { coordinate: [1, 1] },
      left_mouse_down: {},
      left_mouse_up: {},
      cursor_position: {},
      scroll: { coordinate: [1, 1], scroll_direction: "left" },
      type: { text: "hi" },
      key: { text: "ctrl+s", repeat: 2 },
      hold_key: { text: "shift", duration: 1 },
      wait: { duration: 1 },
    };
    expect(Object.keys(members)).toHaveLength(17);
    for (const [action, input] of Object.entries(members))
      expect(Array.isArray(toComputerActions({ action, ...input }, "pixels", F)), action).toBe(
        true,
      );
  });

  it("refuses malformed actions with a message for the model", () => {
    for (const input of [
      { action: "zoom", region: [300, 300, 100, 100] },
      { action: "key" },
      { action: "type" },
      { action: "type", text: "x", coordinate: [5000, 5] },
      { action: "left_click", coordinate: [5000, 5] },
      { action: "left_mouse_down", button: "back" },
      { action: "left_click_drag", start_coordinate: 5, coordinate: [1, 1] },
      { action: "left_click_drag", path: [{ length: 2, 0: 1, 1: 2 }, [1, 1]] },
      { action: "teleport" },
    ] as unknown as ProviderComputerInput[]) {
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
