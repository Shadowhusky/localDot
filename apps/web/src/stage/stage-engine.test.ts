// @vitest-environment jsdom
import { expect, it } from "vitest";
import { APPEARANCE_EVENT } from "../onboarding/appearance.ts";
import { FakeWorker, fakeChromium } from "../testing/fake-chromium.ts";
import { holdEngine } from "./stage-engine.ts";

// A kept stage outlives its page in tests and on a remount; one that is away read the theme from
// whatever the document held then, and threw where it held no tokens.
it("reads the appearance of a kept stage when it is placed again, not while it is away", () => {
  const restore = fakeChromium();
  const key = {};
  const anchor = document.createElement("template");
  document.body.append(anchor);
  try {
    const held = holdEngine(key);
    held.engine.place(anchor);
    const worker = FakeWorker.instances.at(-1);
    const themes = () => worker?.sent.filter(({ message }) => message.type === "theme").length;
    held.engine.unplace(anchor);
    held.release();
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
    expect(themes()).toBe(0);
    const again = holdEngine(key);
    again.engine.place(anchor);
    expect(themes()).toBe(1);
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
    expect(themes()).toBe(2);
    again.engine.close();
  } finally {
    anchor.remove();
    restore();
  }
});
