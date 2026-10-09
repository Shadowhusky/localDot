import { describe, expect, it } from "vitest";
import { LINE_HOLD_MS, LINE_IN_MS, LINE_OUT_MS } from "../shell/narration.ts";
import {
  bandHeight,
  clampLines,
  DOT_LAYOUT_W,
  dotLayout,
  dotSeed,
  LineTrack,
  pictureHeight,
  withBand,
} from "./dot-band.ts";

describe("dot's band in a video", () => {
  it("is as tall, for the video's width, as the app's band under a laptop stage", () => {
    expect(bandHeight(DOT_LAYOUT_W)).toBe(112);
    expect(bandHeight(1920)).toBe(210);
    expect(bandHeight(1280)).toBe(140);
    expect(bandHeight(769) % 2).toBe(0);
    expect(withBand({ w: 1920, h: 1200 })).toEqual({ w: 1920, h: 1410 });
    expect(pictureHeight({ size: { w: 1920, h: 1410 }, dot: "under" })).toBe(1200);
    expect(pictureHeight({ size: { w: 1920, h: 1200 }, dot: "over" })).toBe(1200);
    expect(pictureHeight({ size: { w: 1920, h: 1200 } })).toBe(1200);
  });

  it("docks dot at the picture's corner with its line beside the ball, as in the app", () => {
    const under = dotLayout({ w: 1024, h: 752 }, "under");
    expect(under.pictureH).toBe(640);
    // The ball (three quarters of the frame) starts 20 in and 12 under the picture.
    expect(under.frame).toEqual({ x: 8, y: 640, size: 96 });
    expect(under.frame.x + under.frame.size / 8).toBe(20);
    expect(under.line).toEqual({ x: 112, centreY: 640 + 48, maxW: 600, maxLines: 2 });
    expect(under.band).toEqual({ y: 640, h: 112, spillH: 170 });
    const big = dotLayout({ w: 2048, h: 1504 }, "under");
    expect(big.frame).toEqual({ x: 16, y: 1280, size: 192 });
    expect(big.type.size).toBe(32);
  });

  it("puts dot in the picture's lower left with its line in a bubble beside it", () => {
    const over = dotLayout({ w: 1024, h: 640 }, "over");
    expect(over.band).toBeNull();
    expect(over.pictureH).toBe(640);
    const ball = { left: over.frame.x + over.frame.size / 8, size: (over.frame.size * 3) / 4 };
    expect(ball.left).toBe(20);
    expect(over.frame.y + over.frame.size / 8 + ball.size).toBe(640 - 20);
    expect(over.line.centreY).toBe(640 - 20 - ball.size / 2);
    expect(over.line.x - (over.bubble?.padX ?? 0)).toBe(ball.left + ball.size + 10);
  });
});

describe("the line dot says", () => {
  it("shows the first line at once and fades it in", () => {
    const track = new LineTrack("Opening the report.", 0);
    expect(track.at("Opening the report.", 0)).toEqual({ text: "Opening the report.", alpha: 0 });
    expect(track.at("Opening the report.", LINE_IN_MS / 2).alpha).toBeGreaterThan(0.5);
    expect(track.at("Opening the report.", LINE_IN_MS).alpha).toBe(1);
  });

  it("holds each line, fades it out, then shows the next", () => {
    const track = new LineTrack("First.", 0);
    expect(track.at("Second.", 200)).toEqual({ text: "First.", alpha: 1 });
    expect(track.at("Second.", LINE_HOLD_MS - 1).text).toBe("First.");
    const leaving = track.at("Second.", LINE_HOLD_MS + LINE_OUT_MS / 2);
    expect(leaving.text).toBe("First.");
    expect(leaving.alpha).toBeLessThan(0.5);
    const next = track.at("Second.", LINE_HOLD_MS + LINE_OUT_MS);
    expect(next).toEqual({ text: "Second.", alpha: 0 });
    expect(track.at("Second.", LINE_HOLD_MS + LINE_OUT_MS + LINE_IN_MS).alpha).toBe(1);
  });

  it("skips a line that is replaced before its turn, and keeps a line that comes back", () => {
    const track = new LineTrack("First.", 0);
    track.at("Second.", 100);
    track.at("Third.", 300);
    expect(track.at("Third.", LINE_HOLD_MS + LINE_OUT_MS).text).toBe("Third.");
    track.at("Fourth.", 3000);
    expect(track.at("Third.", 3001)).toEqual({ text: "Third.", alpha: 1 });
    expect(track.at("Third.", 5000).text).toBe("Third.");
  });

  it("waits out the hold after a line that arrives late, then swaps without a gap", () => {
    const track = new LineTrack("First.", 0);
    expect(track.at("Second.", 5000)).toEqual({ text: "First.", alpha: 1 });
    expect(track.at("Second.", 5000 + LINE_OUT_MS).text).toBe("Second.");
  });

  it("fades out to nothing when dot goes quiet", () => {
    const track = new LineTrack("Done.", 0);
    expect(track.at("", 500).text).toBe("Done.");
    expect(track.at("", LINE_HOLD_MS + LINE_OUT_MS)).toEqual({ text: "", alpha: 0 });
  });
});

describe("clamping a line", () => {
  // Ten characters to a line.
  const lines = (text: string) => Math.ceil(text.length / 10);

  it("keeps a line that fits", () => {
    expect(clampLines("Short one.", 2, lines)).toBe("Short one.");
  });

  it("cuts a long line at a word with an ellipsis", () => {
    const cut = clampLines("Checking the net total against revenue minus returns.", 2, lines);
    expect(cut).toBe("Checking the net…");
    expect(lines(cut)).toBeLessThanOrEqual(2);
  });

  it("cuts inside one word longer than the lines", () => {
    const cut = clampLines("a".repeat(50), 2, lines);
    expect(cut).toBe(`${"a".repeat(19)}…`);
  });
});

describe("dot's seed", () => {
  it("is the same for a recording wherever its video is made, and differs between recordings", () => {
    expect(dotSeed("01M4G9PPB8ZKRYW42NAJT2T0S2")).toBe(dotSeed("01M4G9PPB8ZKRYW42NAJT2T0S2"));
    expect(dotSeed("01M4G9PPB8ZKRYW42NAJT2T0S2")).not.toBe(dotSeed("01M4G9PPB8ZKRYW42NAJT2T0S3"));
    expect(Number.isSafeInteger(dotSeed("x"))).toBe(true);
  });
});
