// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { type RefObject, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlip } from "./flip.ts";
import { foldAway, leaveRows } from "./leave.ts";

interface Played {
  element: Element;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>;
}

let played: Played[] = [];
const reduced = { matches: false };

function animations() {
  played = [];
  Element.prototype.animate = function (
    this: Element,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    const cancel = vi.fn();
    played.push({ element: this, frames, options, cancel });
    return { cancel, finished: Promise.resolve() } as unknown as Animation;
  } as unknown as Element["animate"];
  Element.prototype.getAnimations = () => [];
}

beforeEach(() => {
  reduced.matches = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduced-motion") && reduced.matches,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).animate;
  delete (Element.prototype as Partial<Element>).getAnimations;
});

const made = <Ids extends string[]>(...ids: Ids) =>
  ids.map((id) => {
    const row = document.createElement("div");
    row.id = id;
    document.body.append(row);
    return row;
  }) as { [Key in keyof Ids]: HTMLElement };

describe("leaveRows", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("takes them out at once where nothing can animate", () => {
    const remove = vi.fn();
    const after = vi.fn();
    leaveRows(made("a"), remove, { after });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("takes them out at once with none on show, still in one commit", () => {
    animations();
    const remove = vi.fn();
    leaveRows(made("a", "b"), remove, { shown: [] });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(played).toHaveLength(0);
  });

  it("fades those on show in their turn, inert, and takes them all out once, after the hold", () => {
    vi.useFakeTimers();
    animations();
    const [a, b, c] = made("a", "b", "c");
    const remove = vi.fn(() => {
      a.remove();
      b.remove();
      c.remove();
    });
    const after = vi.fn();
    leaveRows([a, b, c], remove, {
      shown: [a, b],
      delayOf: (index) => index * 50,
      hold: 200,
      after,
    });
    expect(played.map((each) => each.element)).toEqual([a, b]);
    expect(played.map((each) => each.options.delay)).toEqual([0, 50]);
    expect(a.inert).toBe(true);
    expect(a.dataset.leaving).toBe("");
    expect(c.inert).toBeFalsy();
    vi.advanceTimersByTime(199);
    expect(remove).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("gives back whole a row still listed after the commit", () => {
    vi.useFakeTimers();
    animations();
    const [row] = made("a");
    leaveRows([row], () => {});
    expect(row.inert).toBe(true);
    vi.runAllTimers();
    expect(row.inert).toBeFalsy();
    expect(row.dataset.leaving).toBeUndefined();
    expect(played[0]?.cancel).toHaveBeenCalled();
  });

  it("only touches what it can compose: transform and opacity", () => {
    vi.useFakeTimers();
    animations();
    leaveRows(made("a"), () => {});
    for (const frame of played[0]?.frames ?? [])
      expect(Object.keys(frame).filter((key) => key !== "opacity")).toEqual([]);
  });
});

describe("foldAway", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("resolves at once for no row, or where nothing can animate", async () => {
    await expect(foldAway(null)).resolves.toBeUndefined();
    await expect(foldAway(made("a")[0])).resolves.toBeUndefined();
  });

  it("folds its height and closes the list's gap, inert", async () => {
    animations();
    const list = document.createElement("div");
    list.style.rowGap = "2px";
    const [row, next] = made("a", "b");
    list.append(row, next);
    document.body.append(list);
    await foldAway(row);
    expect(row.inert).toBe(true);
    const end = played[0]?.frames.at(-1) as Record<string, unknown>;
    expect(end.height).toBe("0px");
    expect(end.opacity).toBe(0);
    expect(end.marginBottom).toBe("-2px");
  });

  it("under reduced motion only fades", async () => {
    animations();
    reduced.matches = true;
    await foldAway(made("a")[0]);
    expect(played[0]?.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
  });

  it("hands focus that was in the row to the one beside it", async () => {
    animations();
    const [row, next] = made("a", "b");
    const inside = document.createElement("button");
    row.append(inside);
    const beside = document.createElement("button");
    next.append(beside);
    inside.focus();
    await foldAway(row);
    expect(document.activeElement).toBe(beside);
  });

  it("leaves focus that is elsewhere alone", async () => {
    animations();
    const [row, next, other] = made("a", "b", "c");
    next.append(document.createElement("button"));
    const elsewhere = document.createElement("button");
    other.append(elsewhere);
    elsewhere.focus();
    await foldAway(row);
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe("useFlip after closeGap", () => {
  it("moves no one where nothing changed, and glides those that moved with no arrival", () => {
    animations();
    const tops = new Map([
      ["a", 0],
      ["b", 50],
      ["c", 100],
    ]);
    const Boxes = () => {
      const [ids, setIds] = useState(["a", "b", "c"]);
      const ref = useRef<HTMLDivElement>(null);
      useFlip(ref as RefObject<HTMLElement | null>, ids.join(" "));
      return (
        <div ref={ref}>
          {ids.map((id) => (
            <div
              key={id}
              data-flip={id}
              ref={(element) => {
                if (!element) return;
                element.getBoundingClientRect = () => ({ top: tops.get(id) ?? 0 }) as DOMRect;
              }}
            />
          ))}
          <button type="button" onClick={() => setIds(["b", "c"])}>
            drop
          </button>
        </div>
      );
    };
    render(<Boxes />);
    played = [];
    tops.set("b", 0);
    tops.set("c", 50);
    act(() => screen.getByRole("button").click());
    expect(played.map((each) => (each.element as HTMLElement).dataset.flip)).toEqual(["b", "c"]);
    expect(played[0]?.frames[0]?.transform).toBe("translateY(50px)");
  });
});
