import { describe, expect, it } from "vitest";
import { enterCode, eraseCode } from "./code.ts";

describe("code cells", () => {
  it("fills every cell from a pasted or messaged code, without spaces or dashes", () => {
    expect(enterCode("", 0, "123 456", 6)).toEqual({ code: "123456", focus: 5 });
    expect(enterCode("12", 3, "98-7654", 6)).toEqual({ code: "987654", focus: 5 });
  });

  it("moves on as each character is typed, from the first empty cell", () => {
    expect(enterCode("", 0, "4", 6)).toEqual({ code: "4", focus: 1 });
    expect(enterCode("4", 4, "2", 6)).toEqual({ code: "42", focus: 2 });
    expect(enterCode("421", 1, "9", 6)).toEqual({ code: "491", focus: 2 });
    expect(enterCode("12345", 5, "6", 6)).toEqual({ code: "123456", focus: 5 });
    expect(enterCode("123", 1, " ", 6)).toEqual({ code: "123", focus: 1 });
  });

  it("steps back on Backspace", () => {
    expect(eraseCode("123", 1)).toEqual({ code: "13", focus: 1 });
    expect(eraseCode("123", 4)).toEqual({ code: "12", focus: 2 });
    expect(eraseCode("", 0)).toEqual({ code: "", focus: 0 });
  });
});
