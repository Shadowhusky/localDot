import type { DotPlacement, ExportSize } from "@localdot/protocol";
import {
  CanvasSource,
  CanvasTextMetrics,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  Texture,
} from "pixi.js";
import { type RecordedPresence, sayMs } from "../dot/dot-feed.ts";
import { DotEngine, type Point } from "../dot/engine/engine.ts";
import type { DotState } from "../dot/engine/states.ts";
import { gazeTo } from "../dot/gaze.ts";
import { PLATE_FILES, plateFile, SHADOW_FILES } from "../dot/plates.ts";
import { type DotPlates, paintDot } from "../dot/render/dot-paint.ts";
import { lodFor } from "../dot/render/lod.ts";
import type { StageTheme, ThemeColor } from "../stage/theme.ts";
import { clampLines, type DotLayout, dotLayout, LineTrack } from "./dot-band.ts";

// The stage's light on the floor (design-v2 §4): neutral, and xenon while dot has control, with the
// rim's glow just under the picture. The rim fades in over 400 ms and out over 300 ms.
const SPILL = "rgba(220,228,238,0.07)";
const SPILL_XENON = "rgba(63,181,222,0.11)";
const LIGHT_IN_MS = 400;
const LIGHT_OUT_MS = 300;
const MARK_MS = 150;
// Idle eyes lean this far toward the picture's centre, as docked in the app.
const BIAS_SHARE = 0.75;
const BUBBLE_ALPHA = 0.92;
// A blurred shadow's share of its colour at fractions of the blur past the edge (a Gaussian's tail).
const GLOW_FALLOFF = [
  [0, 0.5],
  [0.25, 0.31],
  [0.5, 0.16],
  [0.75, 0.067],
  [1, 0.023],
  [1.25, 0],
] as const;

const css = (c: ThemeColor) =>
  `rgba(${(c.color >> 16) & 255},${(c.color >> 8) & 255},${c.color & 255},${c.alpha})`;

// The body plates at the size the video draws dot; null when they can't load, so the body is drawn.
export async function loadDotPlates(px: number, signal: AbortSignal): Promise<DotPlates | null> {
  const load = async (url: string) => {
    const response = await fetch(new URL(url, self.location.href), { signal });
    if (!response.ok) throw new Error(`plate ${response.status}`);
    return createImageBitmap(await response.blob());
  };
  try {
    const [neutral, xenon, dim, shadow] = await Promise.all([
      load(plateFile(PLATE_FILES.neutral, px)),
      load(plateFile(PLATE_FILES.xenon, px)),
      load(plateFile(PLATE_FILES.dim, px)),
      load(plateFile(SHADOW_FILES, px)),
    ]);
    return { neutral, xenon, dim, shadow };
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

function spillTexture(width: number, height: number, color: string, glow: boolean): Texture {
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(width)),
    Math.max(1, Math.round(height)),
  );
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const w = canvas.width;
    const h = canvas.height;
    // An ellipse half as wide as 92 % of the picture and 70 % as tall as the light, centred on the
    // picture's foot, fading out 70 % of the way to its edge.
    ctx.save();
    ctx.translate(w / 2, 0);
    ctx.scale(0.46 * w, 0.7 * h);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.7, color.replace(/[\d.]+\)$/, "0)"));
    ctx.fillStyle = gradient;
    ctx.fillRect(-1 / 0.92, 0, 2 / 0.92, 1 / 0.7);
    ctx.restore();
    if (glow) {
      // The rim's outer glows (28 and 90 px blurs) as they fall off under the picture's edge.
      const s = w / 1024;
      for (const [alpha, blur] of [
        [0.32, 28],
        [0.14, 90],
      ] as const) {
        const reach = 1.25 * blur * s;
        const edge = ctx.createLinearGradient(0, 0, 0, reach);
        for (const [at, share] of GLOW_FALLOFF)
          edge.addColorStop(at / 1.25, `rgba(63,181,222,${(alpha * share).toFixed(4)})`);
        ctx.fillStyle = edge;
        ctx.fillRect(0, 0, w, reach);
      }
    }
  }
  return new Texture({
    source: new CanvasSource({
      resource: canvas,
      width: canvas.width,
      height: canvas.height,
      resolution: 1,
    }),
  });
}

function shadeTexture(px: number): Texture {
  const canvas = new OffscreenCanvas(px, px);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const k = px / 64;
    const shade = ctx.createRadialGradient(32 * k, 34 * k, 0, 32 * k, 34 * k, 30 * k);
    shade.addColorStop(0.75, "rgba(0,0,0,0.26)");
    shade.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, px, px);
  }
  return new Texture({
    source: new CanvasSource({ resource: canvas, width: px, height: px, resolution: 1 }),
  });
}

// dot in an exported video, as the app shows it: its engine run on the video's own clock, fed the
// recording's states, gaze and line at each frame, drawn under the picture in the band or in a
// corner of it with its line in a bubble.
export class ExportDot extends Container {
  readonly #layout: DotLayout;
  readonly #engine: DotEngine;
  readonly #canvas: OffscreenCanvas;
  readonly #context: OffscreenCanvasRenderingContext2D | null;
  readonly #texture: Texture;
  readonly #plates: DotPlates | null;
  readonly #xenon: string;
  readonly #lod = lodFor(96);
  readonly #track: LineTrack;
  readonly #words = new Container();
  readonly #bubble = new Graphics();
  readonly #text: Text;
  readonly #style: TextStyle;
  readonly #mark = new Graphics();
  readonly #light: Sprite | null = null;
  readonly #theme: StageTheme;
  readonly #size: ExportSize;
  #state: DotState;
  #control: boolean;
  #focus: string | null = null;
  #dispatched: string | null;
  #done: boolean;
  #said: string;
  #shown = "";
  #lightLevel: number;
  #markLevel: number;
  #t: number;

  constructor(o: {
    theme: StageTheme;
    size: ExportSize;
    placement: DotPlacement;
    plates: DotPlates | null;
    seed: number;
    t: number;
    first: RecordedPresence;
  }) {
    super();
    const layout = dotLayout(o.size, o.placement);
    this.#layout = layout;
    this.#theme = o.theme;
    this.#size = o.size;
    this.#plates = o.plates;
    this.#xenon = css(o.theme.xenon);
    const { feed, line } = o.first;
    this.#state = feed.state;
    this.#control = feed.control;
    this.#dispatched = feed.dispatched;
    this.#done = feed.done;
    this.#said = line;
    this.#lightLevel = feed.control ? 1 : 0;
    this.#markLevel = feed.attention ? 1 : 0;
    this.#t = o.t;
    this.#engine = new DotEngine({
      seed: o.seed,
      t: o.t,
      state: feed.state,
      lod: this.#lod,
      reducedMotion: false,
      control: feed.control,
    });
    const centre = this.#centre();
    const bias = gazeTo(
      (o.size.w / 2 - centre.x) / layout.scale,
      (layout.pictureH / 2 - centre.y) / layout.scale,
    );
    this.#engine.setBias({ x: bias.x * BIAS_SHARE, y: bias.y * BIAS_SHARE }, o.t);
    this.#aim(feed.focus, o.t);
    if (line) this.#engine.say(o.t, sayMs(line));

    const band = layout.band;
    if (band) {
      const floor = new Graphics()
        .rect(0, band.y, o.size.w, band.h)
        .fill({ color: o.theme.void.color, alpha: 1 });
      const spill = new Sprite(spillTexture(o.size.w, band.spillH, SPILL, false));
      spill.position.set(0, band.y);
      const light = new Sprite(spillTexture(o.size.w, band.spillH, SPILL_XENON, true));
      light.position.set(0, band.y);
      this.#light = light;
      this.addChild(floor, spill, light);
    }

    const px = Math.max(16, Math.round(layout.frame.size));
    this.#canvas = new OffscreenCanvas(px, px);
    this.#context = this.#canvas.getContext("2d");
    this.#texture = new Texture({
      source: new CanvasSource({ resource: this.#canvas, width: px, height: px, resolution: 1 }),
    });
    const body = new Sprite(this.#texture);
    body.position.set(layout.frame.x, layout.frame.y);
    body.scale.set(layout.frame.size / px);
    // On the picture, a soft shade under the ball keeps it apart from a light screen.
    if (!band) {
      const shade = new Sprite(shadeTexture(px));
      shade.position.copyFrom(body.position);
      shade.scale.copyFrom(body.scale);
      this.addChild(shade);
    }

    // The attention mark: an amber point at the ball's upper right, ringed in the house colour.
    const s = layout.scale;
    this.#mark
      .circle(
        layout.frame.x + 0.77 * layout.frame.size,
        layout.frame.y + 0.23 * layout.frame.size,
        5 * s,
      )
      .fill({ color: o.theme.attention.color, alpha: 1 })
      .stroke({ color: o.theme.void.color, width: 2 * s, alignment: 0 });

    this.#style = new TextStyle({
      fontFamily: o.theme.font,
      fontSize: layout.type.size,
      fontWeight: "500",
      lineHeight: layout.type.lineHeight,
      letterSpacing: layout.type.tracking,
      fill: o.theme.text.color,
      wordWrap: true,
      breakWords: true,
      wordWrapWidth: layout.line.maxW,
    });
    this.#text = new Text({ text: "", style: this.#style });
    this.#words.addChild(this.#bubble, this.#text);
    this.addChild(body, this.#mark, this.#words);
    this.#track = new LineTrack(line, o.t);
  }

  // Moves dot to video time t (ms, never backwards) with what the recording shows at that moment.
  update(t: number, { feed, line, forUser }: RecordedPresence): void {
    const engine = this.#engine;
    const dt = Math.max(0, t - this.#t);
    this.#t = t;
    if (feed.state !== this.#state) engine.setState(feed.state, t);
    this.#state = feed.state;
    if (feed.control !== this.#control) engine.setControl(feed.control, t);
    this.#control = feed.control;
    this.#aim(feed.focus, t);
    if (feed.dispatched && feed.dispatched !== this.#dispatched) engine.react("dispatch", t);
    this.#dispatched = feed.dispatched;
    if (feed.done && !this.#done) engine.react("success", t);
    this.#done = feed.done;
    if (line && line !== this.#said) engine.say(t, sayMs(line));
    this.#said = line;

    if (this.#context)
      paintDot(this.#context, engine.pose(t), {
        px: this.#canvas.width,
        lod: this.#lod,
        plates: this.#plates,
        xenon: this.#xenon,
        shadow: this.#layout.band !== null,
      });
    this.#texture.source.update();

    this.#lightLevel = approach(this.#lightLevel, feed.control, dt, LIGHT_IN_MS, LIGHT_OUT_MS);
    if (this.#light) this.#light.alpha = this.#lightLevel;
    this.#markLevel = approach(this.#markLevel, feed.attention, dt, MARK_MS, MARK_MS);
    this.#mark.alpha = this.#markLevel;

    const shown = this.#track.at(line, t, forUser);
    if (shown.text !== this.#shown) this.#say(shown.text);
    this.#words.alpha = shown.alpha;
  }

  #centre(): Point {
    const { frame } = this.#layout;
    return { x: frame.x + frame.size / 2, y: frame.y + frame.size / 2 };
  }

  // dot looks at the action point on the picture, in the app's own pixels.
  #aim(focus: Point | null, t: number): void {
    const key = focus ? `${focus.x},${focus.y}` : null;
    if (key === this.#focus) return;
    this.#focus = key;
    if (!focus) {
      this.#engine.setFocus(null, t);
      return;
    }
    const centre = this.#centre();
    const { scale, pictureH } = this.#layout;
    this.#engine.setFocus(
      gazeTo((focus.x * this.#size.w - centre.x) / scale, (focus.y * pictureH - centre.y) / scale),
      t,
    );
  }

  #say(text: string): void {
    this.#shown = text;
    const { line, bubble } = this.#layout;
    const fitted = clampLines(
      text,
      line.maxLines,
      (cut) => CanvasTextMetrics.measureText(cut, this.#style, undefined, true).lines.length,
    );
    this.#text.text = fitted;
    const top = line.centreY - this.#text.height / 2;
    this.#text.position.set(line.x, top);
    this.#bubble.clear();
    if (!bubble || !fitted) return;
    const width = this.#text.width + 2 * bubble.padX;
    const height = this.#text.height + 2 * bubble.padY;
    const radius = Math.min(bubble.radius, height / 2);
    this.#bubble
      .roundRect(line.x - bubble.padX, top - bubble.padY, width, height, radius)
      .fill({ color: this.#theme.hudSolid.color, alpha: BUBBLE_ALPHA })
      .stroke({
        color: 0xffffff,
        alpha: 0.1,
        width: Math.max(1, this.#layout.scale),
        alignment: 1,
      });
  }
}

// A level that eases toward on (1) or off (0) linearly over the given times.
function approach(level: number, on: boolean, dt: number, inMs: number, outMs: number): number {
  return on ? Math.min(1, level + dt / inMs) : Math.max(0, level - dt / outMs);
}
