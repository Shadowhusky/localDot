// @vitest-environment jsdom
import type { PersonaId, Wearable } from "@localdot/protocol";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DotFeed } from "./dot-feed.ts";
import { DotEngine } from "./engine/engine.ts";
import { PresenceLayer } from "./PresenceLayer.tsx";
import { PresenceSlot } from "./PresenceSlot.tsx";
import { setWearing } from "./wearing.ts";

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

const worn = () =>
  [...document.querySelectorAll<HTMLElement>(".presence-frame .dot-wear")].map(
    (img) => img.dataset.wear,
  );

describe("the presence layer", () => {
  it("wears the dot the task works as, and the user's own without one", async () => {
    setWearing(["hoodie"]);
    const screen = (persona?: PersonaId) => (
      <>
        <PresenceSlot name="dock" className="narrator-dock" />
        <PresenceLayer place="dock" feed={{ ...FEED, persona }} line="" />
      </>
    );
    const view = render(screen());
    await act(async () => {});
    expect(worn()).toEqual(["hoodie"]);
    view.rerender(screen("design"));
    await act(async () => {});
    expect(worn()).toEqual(["scarf", "beret"]);
    view.rerender(screen());
    await act(async () => {});
    expect(worn()).toEqual(["hoodie"]);
    setWearing([]);
  });

  it("comes on to the page dressed, with no hop, and hops only for a real change", async () => {
    const hop = vi.spyOn(DotEngine.prototype, "hop");
    const screen = (look: readonly Wearable[], arrived = true) => (
      <>
        <PresenceSlot name="dock" className="narrator-dock" />
        <PresenceLayer place="dock" feed={{ ...FEED, look }} line="" arrived={arrived} />
      </>
    );
    const view = render(screen(["crown"], false));
    await act(async () => {});
    expect(worn()).toEqual(["crown"]);

    // What was remembered wasn't so: it gives way, and no one is told.
    view.rerender(screen(["lei"]));
    await act(async () => {});
    expect(worn()).toEqual(["lei"]);
    expect(document.querySelector("[data-arriving]")).toBeNull();
    expect(hop).not.toHaveBeenCalled();

    view.rerender(screen(["cap"]));
    await act(async () => {});
    expect(worn()).toContain("cap");
    expect(document.querySelector('[data-wear="cap"]')?.hasAttribute("data-arriving")).toBe(true);
    expect(hop).toHaveBeenCalledOnce();
  });

  it("stays out of sight until all it wears can be drawn", async () => {
    const waiting: (() => void)[] = [];
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: () => new Promise<void>((resolve) => waiting.push(resolve)),
    });
    render(
      <>
        <PresenceSlot name="dock" className="narrator-dock" />
        <PresenceLayer place="dock" feed={{ ...FEED, look: ["pearls"] }} line="" />
      </>,
    );
    const frame = document.querySelector<HTMLElement>(".presence-frame");
    expect(frame?.dataset.shown).toBeUndefined();
    await act(async () => {
      for (const resolve of waiting.splice(0)) resolve();
      await new Promise((resolve) => setTimeout(resolve));
    });
    expect(frame?.dataset.shown).toBe("");
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  });

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
