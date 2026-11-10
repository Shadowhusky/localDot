// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DotAvatar } from "./DotAvatar.tsx";

function holdDecodes() {
  const waiting: (() => void)[] = [];
  vi.stubGlobal("Image", window.Image);
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => new Promise<void>((resolve) => waiting.push(resolve)),
  });
  return async () => {
    await act(async () => {
      for (const resolve of waiting.splice(0)) resolve();
    });
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
});

const worn = (root: Element) =>
  [...root.querySelectorAll<HTMLElement>(".dot-wear")].map((img) => img.dataset.wear);

const eyeWidth = (root: Element) => Number(root.querySelector(".dot-eye")?.getAttribute("width"));

describe("a list's still dot", () => {
  it("is a plain ball until its plates are in, then shows all of them together", async () => {
    const decode = holdDecodes();
    const { container } = render(<DotAvatar size={41} wearables={["cap", "lei"]} />);
    const avatar = container.querySelector<HTMLElement>(".dot-avatar");
    expect(avatar?.dataset.loading).toBe("");
    expect(container.querySelector("img")).toBeNull();
    await decode();
    expect(avatar?.dataset.loading).toBeUndefined();
    expect(container.querySelector(".dot-plate")).not.toBeNull();
    expect(worn(container)).toEqual(["cap", "lei"]);
  });

  it("keeps its look on until the next one's plates are in", async () => {
    const decode = holdDecodes();
    const { container, rerender } = render(<DotAvatar size={42} wearables={["cap"]} />);
    await decode();
    rerender(<DotAvatar size={42} wearables={["crown"]} />);
    expect(worn(container)).toEqual(["cap"]);
    await decode();
    expect(worn(container)).toEqual(["crown"]);
  });

  it("has the eyes a live dot of its size has, kept to their true size behind a lens", async () => {
    const decode = holdDecodes();
    const small = render(<DotAvatar size={32} wearables={["cap"]} />);
    const large = render(<DotAvatar size={96} wearables={["cap"]} />);
    const lens = render(<DotAvatar size={32} wearables={["round-glasses"]} />);
    await decode();
    expect(eyeWidth(small.container)).toBeCloseTo(6.75);
    expect(eyeWidth(large.container)).toBeCloseTo(5.4);
    expect(eyeWidth(lens.container)).toBeCloseTo(5.4);
  });

  it("carries what is on its face with its eyes, wherever its seed has it look", async () => {
    const decode = holdDecodes();
    const { container } = render(<DotAvatar size={64} wearables={["sunglasses"]} seed="task" />);
    await decode();
    const plate = container.querySelector<HTMLElement>(".dot-wear");
    const eye = container.querySelector(".dot-eye");
    const [, , , , dx = 0, dy = 0] = (plate?.style.transform.match(/-?[\d.]+/g) ?? []).map(Number);
    expect(Math.hypot(dx, dy)).toBeGreaterThan(0);
    const x = Number(eye?.getAttribute("x")) + Number(eye?.getAttribute("width")) / 2;
    const y = Number(eye?.getAttribute("y")) + Number(eye?.getAttribute("height")) / 2;
    expect(x - 26.5).toBeCloseTo(dx, 0);
    expect(y - 27.5).toBeCloseTo(dy, 0);
  });

  it("draws at once what has been decoded before", async () => {
    const decode = holdDecodes();
    const first = render(<DotAvatar size={43} wearables={["bow"]} />);
    await decode();
    first.unmount();
    const { container } = render(<DotAvatar size={43} wearables={["bow"]} />);
    expect(worn(container)).toEqual(["bow"]);
  });
});
