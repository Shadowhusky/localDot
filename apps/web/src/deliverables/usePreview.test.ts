import { describe, expect, it } from "vitest";
import { slot } from "./usePreview.ts";

describe("preview slots", () => {
  it("lets two previews load at once and starts the third when one finishes", async () => {
    const signal = new AbortController().signal;
    const first = await slot(signal);
    const second = await slot(signal);
    let third = false;
    const waiting = slot(signal).then((release) => {
      third = true;
      return release;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    first();
    first(); // releasing twice frees one slot only
    const release = await waiting;
    expect(third).toBe(true);
    second();
    release();
  });
  it("drops a queued preview whose file went away", async () => {
    const signal = new AbortController().signal;
    const a = await slot(signal);
    const b = await slot(signal);
    const gone = new AbortController();
    const queued = slot(gone.signal);
    gone.abort(new Error("unmounted"));
    await expect(queued).rejects.toThrow("unmounted");
    a();
    b();
    const next = await slot(signal);
    const other = await slot(signal);
    next();
    other();
  });
});
