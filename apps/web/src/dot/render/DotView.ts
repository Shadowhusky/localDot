import { DotEngine, type EyePose, type Point } from "../engine/engine.ts";
import type { DotState, Lod, Reaction } from "../engine/states.ts";
import { BODY_PLATES, type BodyPlate, SHADOW_PLATE } from "../plates.ts";
import { type Arc, eyeGeometry } from "./eye-geometry.ts";
import { LOD_DETAIL, type LodDetail, lodFor } from "./lod.ts";
import { addView, type Frameable, now, removeView } from "./scheduler.ts";

const SVG = "http://www.w3.org/2000/svg";
// A view left unrendered this long (off screen, hidden tab) jumps ahead instead of replaying it.
const RESYNC_MS = 10_000;
// Below this activity nothing moves fast enough to need every frame.
const CALM = 2;
let uid = 0;

const num = (v: number) => (Math.abs(v) < 1e-4 ? "0" : v.toFixed(3));

type Cache = Record<string, string>;

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent.appendChild(node);
  return node;
}

function stops(gradient: Element, list: [offset: number, color: string, opacity?: number][]): void {
  for (const [offset, color, opacity] of list) {
    svg(
      "stop",
      {
        offset,
        "stop-color": color,
        ...(opacity === undefined ? {} : { "stop-opacity": opacity }),
      },
      gradient,
    );
  }
}

interface Eye {
  g: SVGGElement;
  lid: SVGPathElement;
  shape: SVGRectElement;
  gloss: SVGEllipseElement;
  happy: SVGPathElement;
  closed: SVGPathElement;
  cache: Cache;
}

export interface DotViewOptions {
  size: number;
  state: DotState;
  control: boolean;
  reducedMotion: boolean;
  seed?: number;
}

// Renders a DotEngine into a host element: Blender body plates under a procedural SVG face. The
// neutral plate loads at once, the xenon and dim plates the first time they show, and if any plate
// fails the body falls back to SVG. Attributes and styles are written only when they change.
export class DotView implements Frameable {
  readonly root: HTMLElement;
  visible = true;
  private readonly id = ++uid;
  private readonly engine: DotEngine;
  private size: number;
  private lod: Lod;
  private detail: LodDetail;
  private readonly cache: Cache = {};
  private lastFrame: number;
  private lastRender = Number.NEGATIVE_INFINITY;
  private readonly body: HTMLElement;
  private readonly shadow: HTMLImageElement;
  private readonly plates: Record<BodyPlate, HTMLImageElement>;
  private readonly svgXenon: SVGCircleElement;
  private readonly svgDim: SVGCircleElement;
  private readonly eyes: [Eye, Eye];
  private readonly listeners = new AbortController();

  constructor(root: HTMLElement, o: DotViewOptions) {
    this.root = root;
    this.size = o.size;
    this.lod = lodFor(o.size);
    this.detail = LOD_DETAIL[this.lod];
    const t = now();
    this.lastFrame = t;
    this.engine = new DotEngine({
      seed: o.seed ?? this.id * 7919,
      t,
      state: o.state,
      lod: this.lod,
      reducedMotion: o.reducedMotion,
      control: o.control,
    });

    root.dataset.lod = this.lod;
    root.dataset.skin = "loading";
    this.shadow = this.image("dot-shadow", root);
    this.body = document.createElement("span");
    this.body.className = "dot-body";
    root.appendChild(this.body);
    this.plates = {
      neutral: this.image("dot-plate dot-plate-neutral", this.body),
      xenon: this.image("dot-plate dot-plate-xenon", this.body),
      dim: this.image("dot-plate dot-plate-dim", this.body),
    };
    const { signal } = this.listeners;
    for (const img of Object.values(this.plates)) {
      img.addEventListener(
        "error",
        () => {
          root.dataset.skin = "svg";
        },
        { signal },
      );
    }
    this.plates.neutral.addEventListener(
      "load",
      () => {
        if (root.dataset.skin === "loading") root.dataset.skin = "plate";
      },
      { signal },
    );

    const face = svg(
      "svg",
      { viewBox: "0 0 64 64", class: "dot-face", "shape-rendering": "geometricPrecision" },
      this.body,
    );
    const defs = svg("defs", {}, face);
    const ref = (name: string) => `url(#dot${this.id}-${name})`;
    svg(
      "circle",
      { cx: 32, cy: 32, r: 23.75 },
      svg("clipPath", { id: `dot${this.id}-body` }, defs),
    );
    const eyeFill = svg(
      "linearGradient",
      { id: `dot${this.id}-eye`, x1: 0, y1: 0, x2: 0.35, y2: 1 },
      defs,
    );
    for (const [offset, name] of [
      [0, "hi"],
      [0.42, "mid"],
      [1, "lo"],
    ] as const) {
      svg("stop", { offset, class: `dot-stop-${name}` }, eyeFill);
    }
    stops(svg("radialGradient", { id: `dot${this.id}-gloss` }, defs), [
      [0, "#ffffff", 0.75],
      [0.55, "#ffffff", 0.22],
      [1, "#ffffff", 0],
    ]);
    stops(svg("radialGradient", { id: `dot${this.id}-pearl`, cx: 0.37, cy: 0.3, r: 0.78 }, defs), [
      [0, "#f6f7f8"],
      [0.36, "#eceef0"],
      [0.68, "#d3d6db"],
      [0.9, "#a9adb5"],
      [1, "#8d929a"],
    ]);
    const edge = { cx: 0.3, cy: 0.62, r: 0.95, fx: 0.3, fy: 0.62 };
    stops(svg("radialGradient", { id: `dot${this.id}-sheen`, ...edge }, defs), [
      [0, "#ffffff", 0],
      [0.86, "#ffffff", 0],
      [0.97, "#ffffff", 0.55],
      [1, "#ffffff", 0],
    ]);
    const xenon = svg("radialGradient", { id: `dot${this.id}-xenon`, ...edge }, defs);
    for (const [offset, opacity] of [
      [0, 0],
      [0.84, 0],
      [0.97, 0.85],
      [1, 0],
    ] as const) {
      svg("stop", { offset, class: "dot-stop-xenon", "stop-opacity": opacity }, xenon);
    }
    const disc = { cx: 32, cy: 32, r: 24 };
    const svgBody = svg("g", { class: "dot-svgbody" }, face);
    svg("circle", { ...disc, class: "dot-flat" }, svgBody);
    svg("circle", { ...disc, class: "dot-pearl", fill: ref("pearl") }, svgBody);
    svg("circle", { ...disc, class: "dot-pearl", fill: ref("sheen") }, svgBody);
    this.svgXenon = svg("circle", { ...disc, fill: ref("xenon"), opacity: 0 }, svgBody);
    this.svgDim = svg("circle", { ...disc, fill: "#0a0b0d", opacity: 0 }, svgBody);

    const eyes = svg("g", { "clip-path": ref("body") }, face);
    const eye = (side: "L" | "R"): Eye => {
      const lid = svg("path", { d: "" }, svg("clipPath", { id: `dot${this.id}-lid${side}` }, defs));
      const g = svg("g", {}, eyes);
      const lidded = svg("g", { "clip-path": ref(`lid${side}`) }, g);
      return {
        g,
        lid,
        shape: svg("rect", { class: "dot-eye" }, lidded),
        gloss: svg("ellipse", { fill: ref("gloss"), opacity: 0 }, lidded),
        happy: svg("path", { class: "dot-arc", opacity: 0 }, g),
        closed: svg("path", { class: "dot-arc", opacity: 0 }, g),
        cache: {},
      };
    };
    this.eyes = [eye("L"), eye("R")];

    this.load(this.plates.neutral, BODY_PLATES.neutral);
    this.applyLod();
    this.render(t);
    addView(this);
  }

  setState(state: DotState): void {
    this.engine.setState(state, now());
  }

  setControl(on: boolean): void {
    this.engine.setControl(on, now());
  }

  setReducedMotion(on: boolean): void {
    this.engine.setReducedMotion(on, now());
  }

  react(name: Reaction): void {
    this.engine.react(name, now());
  }

  setFocus(p: Point | null): void {
    this.engine.setFocus(p, now());
  }

  setBias(b: Point): void {
    this.engine.setBias(b, now());
  }

  setPlaces(places: Partial<{ composer: Point; card: Point }>): void {
    this.engine.setPlaces(places, now());
  }

  say(ms: number): void {
    this.engine.say(now(), ms);
  }

  hop(): void {
    this.engine.hop(now());
  }

  setSize(size: number): void {
    if (size === this.size) return;
    this.size = size;
    for (const img of [this.shadow, ...Object.values(this.plates)]) {
      if (img.srcset) img.sizes = `${size}px`;
    }
    const lod = lodFor(size);
    if (lod !== this.lod) {
      this.lod = lod;
      this.detail = LOD_DETAIL[lod];
      this.engine.setLod(lod, now());
      this.applyLod();
    }
    this.render(now());
  }

  destroy(): void {
    removeView(this);
    this.listeners.abort();
    this.root.replaceChildren();
    delete this.root.dataset.lod;
    delete this.root.dataset.skin;
  }

  frame(t: number): void {
    if (t - this.lastFrame > RESYNC_MS) this.engine.skipTo(t);
    this.lastFrame = t;
    if (this.engine.activity(t) < CALM && t - this.lastRender < this.detail.calmGapMs) return;
    this.render(t);
  }

  private image(className: string, parent: Element): HTMLImageElement {
    const img = document.createElement("img");
    img.className = className;
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    parent.appendChild(img);
    return img;
  }

  private load(img: HTMLImageElement, srcset: string): void {
    if (img.srcset) return;
    img.sizes = `${this.size}px`;
    img.srcset = srcset;
  }

  private applyLod(): void {
    this.root.dataset.lod = this.lod;
    if (this.detail.shadow) this.load(this.shadow, SHADOW_PLATE);
  }

  private style(node: HTMLElement, key: string, prop: string, value: string): void {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    node.style.setProperty(prop, value);
  }

  private render(t: number): void {
    const p = this.engine.pose(t);
    this.lastRender = t;
    const k = this.size / 64;
    const dpr = window.devicePixelRatio || 1;
    let x = p.body.x * k;
    let y = p.body.y * k;
    if (this.detail.snap) {
      x = Math.round(x * dpr) / dpr;
      y = Math.round(y * dpr) / dpr;
    }
    this.style(
      this.body,
      "body",
      "transform",
      `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${p.body.sx.toFixed(4)}, ${p.body.sy.toFixed(4)})`,
    );
    if (this.detail.shadow) {
      const s = p.shadow.s;
      this.style(
        this.shadow,
        "shadow",
        "transform",
        `scale(${(s * p.body.sx).toFixed(3)}, ${s.toFixed(3)})`,
      );
      this.style(this.shadow, "shadowOpacity", "opacity", p.shadow.o.toFixed(3));
    }
    const rim = (p.plate.rim * (1 - p.plate.dim)).toFixed(3);
    const dim = p.plate.dim.toFixed(3);
    if (rim !== "0.000") this.load(this.plates.xenon, BODY_PLATES.xenon);
    if (dim !== "0.000") this.load(this.plates.dim, BODY_PLATES.dim);
    this.style(this.plates.xenon, "xenon", "opacity", rim);
    this.style(this.plates.dim, "dim", "opacity", dim);
    this.attr(this.svgXenon, this.cache, "svgXenon", "opacity", rim);
    this.attr(this.svgDim, this.cache, "svgDim", "opacity", (p.plate.dim * 0.42).toFixed(3));
    const devPerUnit = k * dpr;
    this.renderEye(this.eyes[0], p.eyes[0], devPerUnit);
    this.renderEye(this.eyes[1], p.eyes[1], devPerUnit);
  }

  private attr(node: Element, cache: Cache, key: string, name: string, value: string): void {
    if (cache[key] === value) return;
    cache[key] = value;
    node.setAttribute(name, value);
  }

  private renderEye(e: Eye, s: EyePose, devPerUnit: number): void {
    const c = e.cache;
    const g = eyeGeometry(s, this.detail, devPerUnit);
    this.attr(
      e.g,
      c,
      "m",
      "transform",
      `matrix(${num(g.a)} ${num(g.b)} ${num(g.c)} ${num(g.d)} ${num(g.ex)} ${num(g.ey)})`,
    );
    this.attr(e.g, c, "o", "opacity", g.opacity.toFixed(3));
    const { W, top, bottom, slope, dip, arch } = g.lid;
    this.attr(
      e.lid,
      c,
      "lid",
      "d",
      `M${num(-W)} ${num(top - slope * W)} Q0 ${num(top + 2 * dip)} ${num(W)} ${num(top + slope * W)} ` +
        `L${num(W)} ${num(bottom)} Q0 ${num(bottom - 2 * arch)} ${num(-W)} ${num(bottom)} Z`,
    );
    this.attr(e.shape, c, "x", "x", num(-g.hw));
    this.attr(e.shape, c, "y", "y", num(-g.hh));
    this.attr(e.shape, c, "w", "width", num(2 * g.hw));
    this.attr(e.shape, c, "h", "height", num(2 * g.hh));
    this.attr(e.shape, c, "rx", "rx", num(g.hw));
    this.attr(e.shape, c, "ro", "opacity", g.capsule.toFixed(3));
    const fill = this.detail.gloss ? `url(#dot${this.id}-eye)` : "";
    if (c.fill !== fill) {
      c.fill = fill;
      e.shape.style.setProperty("fill", fill);
    }
    if (g.gloss) {
      this.attr(e.gloss, c, "gx", "cx", num(g.gloss.cx));
      this.attr(e.gloss, c, "gy", "cy", num(g.gloss.cy));
      this.attr(e.gloss, c, "grx", "rx", num(g.gloss.rx));
      this.attr(e.gloss, c, "gry", "ry", num(g.gloss.ry));
      this.attr(e.gloss, c, "go", "opacity", g.gloss.opacity.toFixed(3));
    } else {
      this.attr(e.gloss, c, "go", "opacity", "0");
    }
    this.arc(e.happy, c, "h", g.happy);
    this.arc(e.closed, c, "c", g.closed);
  }

  private arc(node: SVGPathElement, c: Cache, key: string, a: Arc): void {
    if (a.opacity > 0.001) {
      this.attr(
        node,
        c,
        `${key}d`,
        "d",
        `M${num(-a.aw)} ${num(a.y)} Q0 ${num(a.peak)} ${num(a.aw)} ${num(a.y)}`,
      );
      this.attr(node, c, `${key}w`, "stroke-width", num(a.stroke));
    }
    this.attr(node, c, `${key}o`, "opacity", a.opacity.toFixed(3));
  }
}
