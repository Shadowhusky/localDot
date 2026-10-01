import { Spine } from "@esotericsoftware/spine-pixi-v8";
import {
  type AvatarParams,
  type AvatarRenderer,
  NEUTRAL_PARAMS,
  type Presence,
} from "@localdot/avatar";
import { Application, Assets, Graphics } from "pixi.js";
import { applyPose } from "./apply.ts";
import type { SpineRigBinding } from "./binding.ts";
import { type Frame, fitFrame, frameRect } from "./layout.ts";
import { mapParams } from "./pose.ts";
import { bindingProblems } from "./validate.ts";

export interface SpineRendererOptions {
  skeletonUrl: string;
  atlasUrl: string;
  binding: SpineRigBinding;
  root: { x: number; y: number };
  frames: Record<Presence, Frame>;
  manualClock?: boolean;
}

export class SpineRenderer implements AvatarRenderer {
  readonly #options: SpineRendererOptions;
  #app: Application | null = null;
  #spine: Spine | null = null;
  #clip: Graphics | null = null;
  #presence: Presence = "glance";
  #observer: ResizeObserver | null = null;

  constructor(options: SpineRendererOptions) {
    this.#options = options;
  }

  async mount(el: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({
      width: Math.max(1, el.clientWidth),
      height: Math.max(1, el.clientHeight),
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: globalThis.devicePixelRatio ?? 1,
      preserveDrawingBuffer: true,
    });
    const { skeletonUrl, atlasUrl } = this.#options;
    let spine: Spine | null = null;
    try {
      for (const src of [skeletonUrl, atlasUrl])
        if (!Assets.resolver.hasKey(src)) Assets.add({ alias: src, src });
      await Assets.load([skeletonUrl, atlasUrl]);
      spine = Spine.from({
        skeleton: skeletonUrl,
        atlas: atlasUrl,
        autoUpdate: !this.#options.manualClock,
      });
      const problems = bindingProblems(this.#options.binding, spine.skeleton.data);
      if (problems.length > 0) {
        throw new Error(`avatar rig does not match its binding: ${problems.join("; ")}`);
      }
      // A setup pose need not be neutral (rig-gen leaves the blush opaque), and the first frame
      // can render before the host's first apply().
      applyPose(spine.skeleton, mapParams(NEUTRAL_PARAMS, this.#options.binding));
    } catch (error) {
      // An initialised app and an auto-updating Spine both keep ticking until destroyed.
      spine?.destroy();
      app.destroy(true, { children: true });
      throw error;
    }
    const clip = new Graphics();
    spine.mask = clip;
    el.appendChild(app.canvas);
    app.stage.addChild(spine, clip);
    this.#app = app;
    this.#spine = spine;
    this.#clip = clip;
    this.#observer = new ResizeObserver(() => {
      app.renderer.resize(Math.max(1, el.clientWidth), Math.max(1, el.clientHeight));
      this.#layout();
    });
    this.#observer.observe(el);
    this.#layout();
  }

  apply(params: AvatarParams, _dtMs: number): void {
    if (this.#spine) applyPose(this.#spine.skeleton, mapParams(params, this.#options.binding));
  }

  setPresence(presence: Presence): void {
    this.#presence = presence;
    this.#layout();
  }

  // Deterministic stepping for recordings; only meaningful with `manualClock`.
  step(seconds: number): void {
    this.#spine?.update(seconds);
    this.#app?.render();
  }

  snapshot(): string {
    this.#app?.render();
    return this.#app?.canvas.toDataURL("image/png") ?? "";
  }

  unmount(): void {
    this.#observer?.disconnect();
    this.#clip?.destroy();
    this.#app?.destroy(true, { children: true });
    this.#observer = null;
    this.#app = null;
    this.#spine = null;
    this.#clip = null;
  }

  #layout(): void {
    const app = this.#app;
    const spine = this.#spine;
    const clip = this.#clip;
    if (!app || !spine || !clip) return;
    const frame = this.#options.frames[this.#presence];
    const placement = fitFrame(frame, this.#options.root, app.screen.width, app.screen.height);
    if (!placement) return;
    spine.scale.set(placement.scale);
    spine.position.set(placement.x, placement.y);
    const { x, y, w, h } = frameRect(frame, this.#options.root, placement);
    clip.clear().rect(x, y, w, h).fill(0xffffff);
  }
}
