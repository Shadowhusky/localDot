import { describe, expect, it } from "vitest";
import {
  HitTestResult,
  InputRequest,
  LaunchRequest,
  SettleRequest,
  TypeRequest,
  ZoomRequest,
} from "./desktopd.ts";

describe("desktopd wire schemas", () => {
  it("defaults the injector to xtest and the hold to 0", () => {
    const req = InputRequest.parse({
      input: { kind: "click", button: "left", count: 1, at: { x: 1, y: 2 } },
    });
    expect(req.injector).toBe("xtest");
    expect(req.holdMs).toBe(0);
  });

  it("caps typed text and rejects an unknown app", () => {
    expect(() =>
      TypeRequest.parse({
        text: "x".repeat(4001),
        masked: false,
        pace: { firstMs: 35, firstCount: 60, restMs: 6 },
      }),
    ).toThrow();
    expect(() => LaunchRequest.parse({ app: "bash" })).toThrow();
    expect(LaunchRequest.parse({ app: "terminal" }).args).toEqual([]);
  });

  it("defaults settle to 250 ms quiet, 1500 ms first change, 3 s cap", () => {
    expect(SettleRequest.parse({})).toEqual({ quietMs: 250, firstMs: 1500, timeoutMs: 3000 });
  });

  it("names the input a settle follows from a fixed set", () => {
    expect(SettleRequest.parse({ verb: "key", firstMs: 400 })).toMatchObject({
      verb: "key",
      firstMs: 400,
    });
    expect(() => SettleRequest.parse({ verb: "drag" })).toThrow();
  });

  it("zooms a frame by its id and a region", () => {
    const region = { x: 10, y: 20, w: 100, h: 50 };
    expect(ZoomRequest.parse({ frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", region }).region).toEqual(
      region,
    );
    expect(() => ZoomRequest.parse({ frameId: "../frame", region })).toThrow();
  });

  it("carries a target name of any length for the gateway to cut", () => {
    const long = {
      point: { x: 1, y: 2 },
      source: "ax",
      name: "n".repeat(300),
      window: "w".repeat(400),
    };
    expect(HitTestResult.parse({ target: long, window: 7, ms: 3 }).target?.name).toHaveLength(300);
  });
});
