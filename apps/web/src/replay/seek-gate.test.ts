import { describe, expect, it, vi } from "vitest";
import { SeekGate } from "./seek-gate.ts";

describe("seeks on their way to the worker", () => {
  it("keeps one preview in flight and only the newest one waiting behind it", () => {
    const send = vi.fn();
    const gate = new SeekGate(send);
    for (let index = 0; index < 500; index++) gate.seek(1000 + index, "preview");
    expect(send.mock.calls).toEqual([[1000, "preview"]]);
    gate.settled();
    expect(send.mock.calls).toEqual([
      [1000, "preview"],
      [1499, "preview"],
    ]);
    gate.settled();
    gate.settled();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends an exact seek at once and drops the preview waiting behind it", () => {
    const send = vi.fn();
    const gate = new SeekGate(send);
    gate.seek(1000, "preview");
    gate.seek(2000, "preview");
    gate.seek(3000, "exact");
    expect(send.mock.calls).toEqual([
      [1000, "preview"],
      [3000, "exact"],
    ]);
    gate.seek(4000, "preview");
    expect(send).toHaveBeenCalledTimes(2);
    gate.settled();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith(4000, "preview");
  });

  it("forgets a waiting preview when playback takes over", () => {
    const send = vi.fn();
    const gate = new SeekGate(send);
    gate.seek(1000, "preview");
    gate.seek(2000, "preview");
    gate.reset();
    gate.settled();
    expect(send).toHaveBeenCalledTimes(1);
    gate.seek(5000, "preview");
    expect(send).toHaveBeenLastCalledWith(5000, "preview");
  });
});
