import { describe, expect, it } from "vitest";
import { localDotHost, localDotOrigin, localDotProblem } from "./local-dots.ts";

describe("another localDot's address", () => {
  it("reads what people type or paste as the origin to open", () => {
    expect(localDotOrigin("office-pc.example.ts.net:4750")).toBe(
      "https://office-pc.example.ts.net:4750",
    );
    expect(localDotOrigin(" http://192.168.1.20:4750/#token=abc ")).toBe(
      "http://192.168.1.20:4750",
    );
    expect(localDotOrigin("https://mini.local/")).toBe("https://mini.local");
    expect(localDotOrigin("")).toBeNull();
    expect(localDotOrigin("ftp://mini.local")).toBeNull();
    expect(localDotOrigin("https://user:pass@mini.local")).toBeNull();
    expect(localDotOrigin("javascript:alert(1)")).toBeNull();
  });

  it("refuses this localDot and one already listed", () => {
    const others = [{ name: "Office", url: "https://office.example:4750" }];
    expect(localDotProblem("studio.example:4750", others, "https://studio.example:4750")).toBe(
      "That's this localDot.",
    );
    expect(localDotProblem("office.example:4750", others, "https://studio.example:4750")).toBe(
      "That localDot is already in the list.",
    );
    expect(
      localDotProblem("laptop.example:4750", others, "https://studio.example:4750"),
    ).toBeNull();
    expect(localDotHost("https://office.example:4750")).toBe("office.example:4750");
  });
});
