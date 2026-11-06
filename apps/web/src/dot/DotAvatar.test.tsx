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

  it("draws at once what has been decoded before", async () => {
    const decode = holdDecodes();
    const first = render(<DotAvatar size={43} wearables={["bow"]} />);
    await decode();
    first.unmount();
    const { container } = render(<DotAvatar size={43} wearables={["bow"]} />);
    expect(worn(container)).toEqual(["bow"]);
  });
});
