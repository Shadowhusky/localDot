// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DotFeed } from "./dot-feed.ts";
import { PresenceLayer } from "./PresenceLayer.tsx";
import { PresenceSlot } from "./PresenceSlot.tsx";

const FEED: DotFeed = {
  state: "idle",
  control: false,
  attention: false,
  focus: null,
  dispatched: null,
  done: false,
};

const BOXES: Record<string, { left: number; top: number; width: number }> = {
  "narrator-dock": { left: 8, top: 716, width: 96 },
  "replay-says-dot": { left: 1072, top: 229, width: 72 },
};

// As in the app, Watch stays mounted and hidden under Replay, each with its own dock.
function Screen({ replay }: { replay: boolean }) {
  return (
    <>
      <div hidden={replay}>
        <PresenceSlot name="dock" className="narrator-dock" />
      </div>
      {replay && <PresenceSlot name="dock" className="replay-says-dot" />}
      <PresenceLayer place="dock" feed={FEED} line="" />
    </>
  );
}

beforeEach(() => {
  // Like a browser, a box inside a hidden view has no size.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const name = Object.keys(BOXES).find((key) => this.classList.contains(key));
    const box = name && !this.closest("[hidden]") ? BOXES[name] : undefined;
    const { left = 0, top = 0, width = 0 } = box ?? {};
    return { left, top, width, height: width } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the presence layer", () => {
  it("keeps dot on screen when the user goes back from Replay to Watch", async () => {
    const view = render(<Screen replay />);
    const frame = document.querySelector<HTMLElement>(".presence-frame");
    expect(frame?.dataset.shown).toBe("");
    expect(frame?.parentElement?.classList.contains("replay-says-dot")).toBe(true);
    view.rerender(<Screen replay={false} />);
    await act(async () => {});
    expect(frame?.dataset.shown).toBe("");
    expect(frame?.parentElement?.classList.contains("narrator-dock")).toBe(true);
  });
});
