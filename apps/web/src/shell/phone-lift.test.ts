// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { copyInto, mix, ramp, sizeOf } from "./phone-lift.ts";

describe("what a lift is drawn from", () => {
  it("eases from nothing to all between two points, and holds either side", () => {
    expect(ramp(0.1, 0.3, 0.8)).toBe(0);
    expect(ramp(0.55, 0.3, 0.8)).toBeCloseTo(0.5);
    expect(ramp(1.2, 0.3, 0.8)).toBe(1);
  });

  it("is on what it came from at nothing, and at its place at all", () => {
    const from = { x: 0, y: 500, w: 390, h: 72 };
    const to = { x: 16, y: 300, w: 358, h: 120 };
    expect(mix(from, to, 0)).toEqual(from);
    expect(mix(from, to, 1)).toEqual(to);
    expect(mix(from, to, 0.5).y).toBe(400);
  });

  it("copies something so that rules written against where it sits still reach it", () => {
    document.body.innerHTML = `
      <section class="screen" id="screen">
        <ul class="list">
          <li class="wrap"></li>
          <li class="wrap" data-holding="">
            <button class="row" id="row" data-pressed=""><i data-pressed="">Name</i></button>
          </li>
        </ul>
      </section>
      <div id="host"></div>`;
    const row = document.getElementById("row") as HTMLElement;
    const host = document.getElementById("host") as HTMLElement;
    copyInto(host, row);
    const copy = host.querySelector(".row") as HTMLElement;
    expect(copy.textContent).toBe("Name");
    // Its ancestors' names, drawing nothing of their own.
    const list = copy.closest(".list") as HTMLElement;
    expect(list.style.display).toBe("contents");
    expect((copy.closest(".screen") as HTMLElement).style.display).toBe("contents");
    expect(host.querySelector(".wrap:has(> .row):last-child")).not.toBeNull();
    // Not first among its neighbours, as it isn't in the page.
    expect(host.querySelector(".wrap:has(> .row):first-child")).toBeNull();
    // Nothing that belongs to the one in the page, or to the press that lifted it.
    expect(host.querySelector("#row, #screen")).toBeNull();
    expect(host.querySelector("[data-pressed], [data-holding]")).toBeNull();
    // It fills its place whatever its rules say.
    expect(copy.style.position).toBe("absolute");
    expect(copy.style.maxWidth).toBe("none");
  });

  it("reads a size to the fraction, not rounded", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element.style, { boxSizing: "border-box", width: "314.6px", height: "71.5px" });
    expect(sizeOf(element)).toEqual({ w: 314.6, h: 71.5 });
    element.remove();
  });
});
