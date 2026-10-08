// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { DotView, type DotViewOptions } from "./DotView.ts";

const views: DotView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function mount(o: Partial<DotViewOptions> = {}) {
  const root = document.createElement("span");
  document.body.appendChild(root);
  const view = new DotView(root, {
    size: 24,
    state: "idle",
    control: false,
    reducedMotion: false,
    seed: 1,
    ...o,
  });
  views.push(view);
  const plate = (name: string) => root.querySelector(`.dot-plate-${name}`) as HTMLImageElement;
  return { root, view, plate };
}

describe("DotView", () => {
  it("loads the neutral plate at once and the xenon and dim plates only when they show", () => {
    const { view, plate } = mount();
    expect(plate("neutral").srcset).toMatch(/body-neutral-48.* 48w, .* 96w, .* 192w, .* 448w$/);
    expect(plate("neutral").sizes).toBe("24px");
    view.frame(performance.now() + 2000);
    expect(plate("xenon").srcset).toBe("");
    expect(plate("dim").srcset).toBe("");

    view.setControl(true);
    view.frame(performance.now() + 50);
    expect(plate("xenon").srcset).toMatch(/body-xenon-48/);
    expect(plate("dim").srcset).toBe("");

    view.setState("offline");
    view.frame(performance.now() + 400);
    expect(plate("dim").srcset).toMatch(/body-dim-48/);
  });

  it("starts with the SVG body, swaps to the plate once it loads, and keeps SVG if a plate fails", () => {
    const loaded = mount();
    expect(loaded.root.dataset.skin).toBe("loading");
    loaded.plate("neutral").dispatchEvent(new Event("load"));
    expect(loaded.root.dataset.skin).toBe("plate");

    const failed = mount({ control: true });
    failed.view.frame(performance.now() + 50);
    failed.plate("xenon").dispatchEvent(new Event("error"));
    expect(failed.root.dataset.skin).toBe("svg");
    failed.plate("neutral").dispatchEvent(new Event("load"));
    expect(failed.root.dataset.skin).toBe("svg");
  });

  it("draws the face with the badge rules and moves to richer detail as it grows", () => {
    const { root, view } = mount();
    expect(root.dataset.lod).toBe("badge");
    expect(root.querySelectorAll(".dot-eye")).toHaveLength(2);
    expect(root.querySelector<HTMLImageElement>(".dot-shadow")?.srcset).toBe("");
    view.setSize(224);
    expect(root.dataset.lod).toBe("hero");
    expect(root.querySelector<HTMLImageElement>(".dot-shadow")?.srcset).toMatch(/shadow-96/);
    expect((root.querySelector(".dot-eye") as SVGRectElement).style.fill).toMatch(/^url\(/);
  });

  it("removes everything it drew when destroyed", () => {
    const { root, view } = mount();
    view.destroy();
    views.splice(views.indexOf(view), 1);
    expect(root.childElementCount).toBe(0);
    expect(root.dataset.skin).toBeUndefined();
  });
});
