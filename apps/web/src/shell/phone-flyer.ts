import type { Wearable } from "@localdot/protocol";
import { DotView } from "../dot/render/DotView.ts";
import { tokenMs } from "../ui/motion.ts";

const FRAME = 64;

export interface FlyerBox {
  x: number;
  y: number;
  w: number;
}

export const boxIn = (element: Element, root: Element): FlyerBox => {
  const box = element.getBoundingClientRect();
  const base = root.getBoundingClientRect();
  return { x: box.left - base.left, y: box.top - base.top, w: box.width };
};

// One dot flown over the stack: from a row as its conversation opens and back as it closes, or into
// the ⋯ button when it is hidden. The live dot stays out of sight meanwhile, so one dot is on show.
export class Flyer {
  private view: DotView | null = null;
  private host: HTMLElement | null = null;
  private landing: Animation | null = null;

  attach(host: HTMLElement | null): void {
    if (host === this.host) return;
    this.view?.destroy();
    this.view = null;
    this.host = host;
  }

  get root(): Element | null {
    return this.host?.parentElement ?? null;
  }

  show(box: FlyerBox, wearables: readonly Wearable[]): DotView | null {
    const host = this.host;
    if (!host) return null;
    this.landing?.cancel();
    if (this.view) this.view.setWearables(wearables);
    else
      this.view = new DotView(host, {
        size: FRAME,
        state: "idle",
        control: false,
        reducedMotion: false,
        wearables,
      });
    this.move(box);
    host.dataset.shown = "";
    host.closest(".app")?.setAttribute("data-dot-away", "");
    return this.view;
  }

  move(box: FlyerBox): void {
    if (this.host)
      this.host.style.transform = `translate3d(${box.x}px,${box.y}px,0) scale(${box.w / FRAME})`;
  }

  // How much of it shows, as something takes it in.
  fade(opacity: number): void {
    if (this.host) this.host.style.opacity = String(opacity);
  }

  hide(): void {
    if (!this.host) return;
    this.landing?.cancel();
    delete this.host.dataset.shown;
    this.host.style.removeProperty("opacity");
    this.host.closest(".app")?.removeAttribute("data-dot-away");
  }

  // Over the dot it stood in for, which comes back under it: it dissolves into that, once that has
  // had a frame to draw, so how each happens to be looking just then never shows as a jump.
  land(): void {
    const host = this.host;
    if (!host || typeof host.animate !== "function") {
      this.hide();
      return;
    }
    host.closest(".app")?.removeAttribute("data-dot-away");
    this.landing?.cancel();
    const motion = host.animate(
      [{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }],
      {
        duration: tokenMs(getComputedStyle(host), "--dur-fade", 150),
      },
    );
    motion.onfinish = () => this.hide();
    this.landing = motion;
  }
}
