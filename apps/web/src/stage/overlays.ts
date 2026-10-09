import {
  type Camera,
  type CancelScene,
  type CursorScene,
  type DragScene,
  dragSegmentAlpha,
  type KeycapsScene,
  type PressScene,
  type RingScene,
  type Scene,
  type ScrollScene,
  type TargetScene,
  type TypingScene,
  toCanvas,
} from "@localdot/stage";
import { BlurFilter, Container, FillGradient, Graphics, Text, TextStyle } from "pixi.js";
import {
  ARROW_BOX_PX,
  CHIP_MIN_STAGE_PX,
  cursorPolygon,
  cursorSizePx,
  targetRadius,
} from "./geometry.ts";
import type { StageTheme, ThemeColor } from "./theme.ts";

const CHIP_H = 20;
const CHIP_OFFSET = { x: 12, y: 18 };
const EDGE_ROOM_PX = 80;
const PILL_H = 28;
const KEY_H = 30;
const KEY_R = 7;
const DISC_R = 14;
const DRAG_PIECE_PX = 8;
const SHADE_ALPHA = 0.3;

// A box shadow's soft edge as stacked rounded rects: a linear ramp across `blur`, cheaper than a
// blur filter behind every chip.
function softShadow(
  g: Graphics,
  w: number,
  h: number,
  radius: number,
  blur: number,
  dy: number,
  shade: ThemeColor,
): void {
  const layers = 6;
  for (let i = 0; i < layers; i++) {
    const grow = blur * ((i + 0.5) / layers - 0.5);
    g.roundRect(-grow, dy - grow, w + 2 * grow, h + 2 * grow, Math.max(0, radius + grow)).fill({
      color: shade.color,
      alpha: SHADE_ALPHA / layers,
    });
  }
}

// The band an inset `0 -depth` shadow leaves along a rounded rect's bottom edge: a keycap's bevel.
function bottomBevel(g: Graphics, w: number, h: number, r: number, depth: number): Graphics {
  return g
    .moveTo(0, h - r)
    .arc(r, h - r, r, Math.PI, Math.PI / 2, true)
    .lineTo(w - r, h)
    .arc(w - r, h - r, r, Math.PI / 2, 0, true)
    .lineTo(w, h - r - depth)
    .arc(w - r, h - r - depth, r, 0, Math.PI / 2)
    .lineTo(r, h - depth)
    .arc(r, h - r - depth, r, Math.PI / 2, Math.PI)
    .closePath();
}

function glassFace(g: Graphics, w: number, h: number, r: number, theme: StageTheme): Graphics {
  return g
    .roundRect(0, 0, w, h, r)
    .fill({ color: theme.glass.color, alpha: theme.glass.alpha })
    .stroke({
      width: 0.5,
      color: theme.hudLine.color,
      alpha: theme.hudLine.alpha,
      alignment: 0,
    });
}

function label(theme: StageTheme, dpr: number, size: number, weight: "500" | "600"): Text {
  return new Text({
    text: "",
    style: new TextStyle({
      fontFamily: theme.font,
      fontSize: size,
      fontWeight: weight,
      fill: theme.text.color,
      letterSpacing: size <= 11 ? 0.06 : 0,
    }),
    resolution: dpr,
  });
}

// dot's chip: a porcelain glyph ringed in xenon and a short label on glass (design-v2 §12).
class GlassChip extends Container {
  readonly #shadow = new Graphics();
  readonly #face = new Graphics();
  readonly #glyph = new Graphics();
  readonly #text: Text;
  #theme: StageTheme;
  #porcelain: FillGradient | null = null;
  #label: string | null = null;
  chipWidth = 0;

  constructor(theme: StageTheme, dpr: number) {
    super();
    this.#theme = theme;
    this.#text = label(theme, dpr, 11, "600");
    this.#glyph.position.set(4, 4);
    this.addChild(this.#shadow, this.#face, this.#glyph, this.#text);
    this.#drawGlyph();
  }

  setTheme(theme: StageTheme): void {
    this.#theme = theme;
    this.#text.style.fill = theme.text.color;
    this.#label = null;
    this.#drawGlyph();
  }

  // dot's porcelain sphere, lit from the upper left, with its two eyes.
  #drawGlyph(): void {
    const t = this.#theme;
    this.#porcelain?.destroy();
    this.#porcelain = new FillGradient({
      type: "radial",
      center: { x: 0.38, y: 0.32 },
      innerRadius: 0,
      outerCenter: { x: 0.38, y: 0.32 },
      outerRadius: 0.92,
      colorStops: [
        { offset: 0, color: t.glyphLight.color },
        { offset: 0.6, color: t.glyphMid.color },
        { offset: 1, color: t.glyphShade.color },
      ],
      textureSpace: "local",
    });
    const ink = t.cursorRim;
    this.#glyph
      .clear()
      .circle(6, 6, 6.5)
      .stroke({ width: 1, color: t.xenon.color, alpha: 0.9 })
      .circle(6, 6, 6)
      .fill(this.#porcelain)
      .roundRect(4.2, 3.5, 1.6, 3.2, 0.8)
      .fill({ color: ink.color, alpha: ink.alpha })
      .roundRect(6.6, 3.5, 1.6, 3.2, 0.8)
      .fill({ color: ink.color, alpha: ink.alpha });
  }

  set(text: string): void {
    if (text === this.#label) return;
    this.#label = text;
    this.#text.text = text;
    const w = Math.ceil(21 + this.#text.width + 8);
    this.chipWidth = w;
    this.#text.position.set(21, (CHIP_H - this.#text.height) / 2);
    this.#shadow.clear();
    softShadow(this.#shadow, w, CHIP_H, CHIP_H / 2, 8, 2, this.#theme.shadeCursor);
    glassFace(this.#face.clear(), w, CHIP_H, CHIP_H / 2, this.#theme);
  }
}

// Draws one Scene. World-space items live in `world` (desktop device px, under the camera);
// screen-constant items counter-scale by `unit` = CSS px in world units; keycaps live in `screen`.
export class Overlays {
  readonly world = new Container();
  readonly screen = new Container();
  #theme: StageTheme;
  readonly #dpr: number;
  #unit = 1;
  #cam: Camera = { scale: 1, tx: 0, ty: 0 };
  #viewport = { w: 1, h: 1 };
  readonly #targetG = new Graphics();
  readonly #dragG = new Graphics();
  readonly #ringsG = new Graphics();
  readonly #discG = new Graphics();
  readonly #scroll = new Container();
  readonly #scrollBody = new Graphics();
  readonly #chevron = new Graphics();
  readonly #typing = new Container();
  readonly #typingBody = new Graphics();
  readonly #typingText: Text;
  readonly #caret = new Graphics();
  #typingKey = "";
  #typingWidth = 0;
  readonly #cursor = new Container();
  readonly #cursorShadow = new Graphics();
  readonly #cursorG = new Graphics();
  #cursorKey = "";
  readonly #nameChip: GlassChip;
  readonly #cancelChip: GlassChip;
  readonly #keycaps = new Container();
  #keycapsLabel = "";
  #keycapsWidth = 0;

  constructor(theme: StageTheme, dpr: number) {
    this.#theme = theme;
    this.#dpr = dpr;
    this.#nameChip = new GlassChip(theme, dpr);
    this.#cancelChip = new GlassChip(theme, dpr);
    this.#typingText = label(theme, dpr, 13, "500");
    this.#typing.addChild(this.#typingBody, this.#typingText, this.#caret);
    this.#scroll.addChild(this.#scrollBody, this.#chevron);
    this.#cursorShadow.filters = [new BlurFilter({ strength: 2 * dpr, quality: 3 })];
    this.#cursor.addChild(this.#cursorShadow, this.#cursorG);
    this.world.addChild(
      this.#targetG,
      this.#dragG,
      this.#ringsG,
      this.#discG,
      this.#scroll,
      this.#typing,
      this.#nameChip,
      this.#cancelChip,
      this.#cursor,
    );
    this.screen.addChild(this.#keycaps);
    this.#drawScrollPill();
  }

  setTheme(theme: StageTheme): void {
    this.#theme = theme;
    for (const chip of [this.#nameChip, this.#cancelChip]) chip.setTheme(theme);
    this.#typingText.style.fill = theme.text.color;
    this.#typingKey = "";
    this.#cursorKey = "";
    this.#keycapsLabel = "";
    this.#drawScrollPill();
  }

  setCamera(cam: Camera): void {
    this.#cam = cam;
    this.#unit = this.#dpr / cam.scale;
  }

  setViewport(w: number, h: number): void {
    this.#viewport = { w, h };
  }

  draw(scene: Scene | null): void {
    this.#targetG.clear();
    this.#dragG.clear();
    this.#ringsG.clear();
    this.#discG.clear();
    this.#cursor.visible = false;
    this.#nameChip.visible = false;
    this.#typing.visible = false;
    this.#cancelChip.visible = false;
    this.#keycaps.visible = false;
    this.#scroll.visible = false;
    if (!scene) return;
    const accent = this.#accent(scene.control);
    if (scene.target) this.#drawTarget(scene.target, accent);
    if (scene.drag) this.#drawDrag(scene.drag, accent);
    for (const ring of scene.rings) this.#drawRing(ring, accent);
    if (scene.press) this.#drawDisc(scene.press, accent);
    if (scene.scroll) this.#drawScroll(scene.scroll);
    if (scene.typing) this.#drawTyping(scene.typing, accent);
    if (scene.cursor?.visible) this.#drawCursor(scene.cursor, scene.control);
    if (scene.keycaps) this.#drawKeycaps(scene.keycaps);
    if (scene.cancel) this.#drawCancel(scene.cancel);
  }

  // Xenon only while dot has control; fg-2 in previews (design-v2 §12).
  #accent(control: boolean): ThemeColor {
    return control ? this.#theme.xenon : this.#theme.text2;
  }

  get #stageWidth(): number {
    return this.#viewport.w / this.#dpr;
  }

  // The focus ring: the element's box padded 3, a 2 px stroke over a 6 px halo at .18.
  #drawTarget(t: TargetScene, accent: ThemeColor): void {
    const u = this.#unit;
    const g = this.#targetG;
    const ring = (grow: number, width: number, alpha: number) => {
      if (t.rect) {
        const pad = (3 + grow) * u;
        const w = (t.rect.w + 2 * pad) * t.scale;
        const h = (t.rect.h + 2 * pad) * t.scale;
        const radius = (targetRadius(t.rect.h / u) + grow) * u * t.scale;
        g.roundRect(
          t.rect.x + t.rect.w / 2 - w / 2,
          t.rect.y + t.rect.h / 2 - h / 2,
          w,
          h,
          Math.min(radius, h / 2),
        );
      } else g.circle(t.point.x, t.point.y, (11 + grow) * u * t.scale);
      g.stroke({ width: width * u * t.scale, color: accent.color, alpha: alpha * t.alpha });
    };
    ring(3, 6, 0.18);
    ring(1, 2, 1);
  }

  // The way the held button went: xenon over a faint dark under-stroke, newest at .85 and the tail
  // fading to .15. Pieces of one opacity share a stroke, so the line never darkens at its joins.
  #drawDrag(drag: DragScene, accent: ThemeColor): void {
    const u = this.#unit;
    const g = this.#dragG;
    const [start, ...rest] = drag.points;
    if (!start) return;
    const under = this.#theme.dragUnder;
    g.moveTo(start.x, start.y);
    for (const p of rest) g.lineTo(p.x, p.y);
    g.stroke({
      width: 7 * u,
      color: under.color,
      alpha: under.alpha * drag.alpha,
      cap: "round",
      join: "round",
    });
    let run = [start];
    let runAlpha = -1;
    const flush = () => {
      const [head, ...tail] = run;
      if (!head || tail.length === 0) return;
      g.moveTo(head.x, head.y);
      for (const p of tail) g.lineTo(p.x, p.y);
      g.stroke({ width: 3 * u, color: accent.color, alpha: runAlpha * drag.alpha, join: "round" });
    };
    let previous = start;
    for (let i = 1; i < drag.points.length; i++) {
      const a = drag.points[i - 1] ?? start;
      const b = drag.points[i] ?? start;
      const ageA = drag.ages[i - 1] ?? 0;
      const ageB = drag.ages[i] ?? 0;
      const pieces = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (DRAG_PIECE_PX * u)));
      for (let k = 1; k <= pieces; k++) {
        const s = k / pieces;
        const p = { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
        const alpha = Math.round(dragSegmentAlpha(ageA + (ageB - ageA) * s) * 20) / 20;
        if (alpha !== runAlpha) {
          flush();
          run = [previous];
          runAlpha = alpha;
        }
        run.push(p);
        previous = p;
      }
    }
    flush();
    // A round cap at the head only (the start marker covers the tail): between runs a cap would
    // overlap its neighbour.
    if (runAlpha >= 0)
      g.circle(previous.x, previous.y, 1.5 * u).fill({
        color: accent.color,
        alpha: runAlpha * drag.alpha,
      });
    const porcelain = this.#theme.cursorFill;
    g.circle(start.x, start.y, 4.5 * u)
      .fill({ color: porcelain.color, alpha: drag.alpha })
      .stroke({ width: 1.5 * u, color: accent.color, alpha: drag.alpha });
  }

  #drawRing(ring: RingScene, accent: ThemeColor): void {
    const u = this.#unit;
    const g = this.#ringsG;
    const r = (ring.d / 2 - 0.75) * u;
    const stroke = { width: 1.5 * u, color: accent.color, alpha: ring.alpha };
    if (ring.style === "left") {
      g.circle(ring.x, ring.y, r).stroke(stroke);
      return;
    }
    // A right click's ripple is dashed 4 / 3 around its circumference.
    const dashes = Math.max(4, Math.round((2 * Math.PI * r) / (7 * u)));
    const step = (2 * Math.PI) / dashes;
    for (let i = 0; i < dashes; i++) {
      const a0 = i * step;
      g.moveTo(ring.x + Math.cos(a0) * r, ring.y + Math.sin(a0) * r)
        .arc(ring.x, ring.y, r, a0, a0 + (step * 4) / 7)
        .stroke(stroke);
    }
  }

  #drawDisc(p: PressScene, accent: ThemeColor): void {
    const u = this.#unit;
    const r = DISC_R * p.scale * u;
    this.#discG
      .circle(p.x, p.y, r)
      .fill({ color: accent.color, alpha: 0.24 * p.alpha })
      .circle(p.x, p.y, r - 0.5 * u)
      .stroke({ width: u, color: accent.color, alpha: 0.6 * p.alpha });
  }

  #drawScrollPill(): void {
    const t = this.#theme;
    this.#scrollBody.clear();
    softShadow(this.#scrollBody, 26, 40, 13, 12, 4, t.shadeCursor);
    glassFace(this.#scrollBody, 26, 40, 13, t);
    this.#scrollBody.position.set(-13, -20);
    this.#chevron
      .clear()
      .moveTo(-4, -2)
      .lineTo(0, 2)
      .lineTo(4, -2)
      .stroke({ width: 2.2, color: t.text.color, cap: "round", join: "round" });
  }

  // Up-right of the hotspot, clear of the name chip, turned to the direction; a sideways scroll
  // turns the pill on its side.
  #drawScroll(s: ScrollScene): void {
    const u = this.#unit;
    const sideways = s.direction === "left" || s.direction === "right";
    this.#scroll.visible = true;
    this.#scroll.alpha = s.alpha;
    this.#scroll.scale.set(u);
    this.#scroll.rotation = { down: 0, up: Math.PI, right: -Math.PI / 2, left: Math.PI / 2 }[
      s.direction
    ];
    this.#scroll.position.set(s.x + (sideways ? 38 : 31) * u, s.y - 8 * u);
    this.#chevron.position.set(0, s.nudge);
  }

  #drawCursor(c: CursorScene, control: boolean): void {
    const u = this.#unit;
    const t = this.#theme;
    this.#cursor.visible = true;
    this.#cursor.position.set(c.x, c.y);
    this.#cursor.rotation = c.lean;
    this.#cursor.alpha = c.alpha;
    this.#cursor.scale.set(
      u * (cursorSizePx(this.#stageWidth) / ARROW_BOX_PX) * (1 - 0.08 * c.press),
    );
    // The arrow changes only with control and the theme, so it is redrawn only then: porcelain
    // with an ink rim over a 3.4 px xenon edge, on a soft shadow 2 px below.
    const key = control ? "control" : "preview";
    if (key !== this.#cursorKey) {
      this.#cursorKey = key;
      const pts = cursorPolygon();
      const edge = control ? t.xenon : t.text2;
      this.#cursorShadow
        .clear()
        .poly(
          pts.map((v, i) => (i % 2 === 1 ? v + 2 : v)),
          true,
        )
        .fill({ color: t.shadeCursor.color, alpha: t.shadeCursor.alpha });
      this.#cursorG
        .clear()
        .poly(pts, true)
        .stroke({ width: 3.4, color: edge.color, alpha: edge.alpha, join: "round" })
        .poly(pts, true)
        .fill({ color: t.cursorFill.color, alpha: t.cursorFill.alpha })
        .stroke({ width: 1.15, color: t.cursorRim.color, alpha: t.cursorRim.alpha, join: "round" });
    }
    if (c.chipAlpha <= 0 || this.#stageWidth < CHIP_MIN_STAGE_PX) return;
    this.#placeChip(this.#nameChip, c.name, c.x, c.y, 0);
    this.#nameChip.alpha = c.chipAlpha * c.alpha;
  }

  // Below-right of the hotspot, flipped left or up near the stage's edge.
  #placeChip(chip: GlassChip, text: string, x: number, y: number, dx: number): void {
    const u = this.#unit;
    chip.set(text);
    chip.visible = true;
    chip.scale.set(u);
    const at = toCanvas(this.#cam, { x, y });
    const room = Math.max(EDGE_ROOM_PX, CHIP_OFFSET.x + chip.chipWidth + 8);
    const left = (this.#viewport.w - at.x) / this.#dpr < room;
    const up = (this.#viewport.h - at.y) / this.#dpr < EDGE_ROOM_PX;
    chip.position.set(
      x + (left ? -(4 + chip.chipWidth) + dx : CHIP_OFFSET.x + dx) * u,
      y + (up ? -(CHIP_H + 6) : CHIP_OFFSET.y) * u,
    );
  }

  // Above the field's left edge (below it when there is no room above), the text so far and a
  // caret.
  #drawTyping(t: TypingScene, accent: ThemeColor): void {
    const u = this.#unit;
    const theme = this.#theme;
    this.#typing.visible = true;
    this.#typing.scale.set(u);
    this.#typing.alpha = t.alpha;
    const text = `${t.more > 0 ? "…" : ""}${t.text}`;
    if (text !== this.#typingKey) {
      this.#typingKey = text;
      this.#typingText.text = text;
      const w = Math.ceil(12 + this.#typingText.width + 4 + 12);
      this.#typingWidth = w;
      this.#typingBody.clear();
      softShadow(this.#typingBody, w, PILL_H, PILL_H / 2, 14, 4, theme.shadeCursor);
      glassFace(this.#typingBody, w, PILL_H, PILL_H / 2, theme);
      this.#typingText.position.set(12, (PILL_H - this.#typingText.height) / 2);
    }
    this.#caret.clear();
    if (t.caretOn)
      this.#caret
        .roundRect(12 + this.#typingText.width + 2, (PILL_H - 14) / 2, 2, 14, 1)
        .fill({ color: accent.color, alpha: 1 });
    const field = t.field ?? { x: t.anchor.x, y: t.anchor.y, w: 0, h: 0 };
    const at = toCanvas(this.#cam, { x: field.x, y: field.y });
    const y = at.y / this.#dpr < 40 ? field.y + field.h + 10 * u : field.y - (PILL_H + 10) * u;
    // Kept 8 px inside the stage when the field sits near its side.
    const left = at.x / this.#dpr - 4;
    const shift = Math.max(8, Math.min(left, this.#stageWidth - 8 - this.#typingWidth)) - left;
    this.#typing.position.set(field.x + (shift - 4) * u, y + t.dy * u);
  }

  #drawKeycaps(k: KeycapsScene): void {
    this.#keycaps.visible = true;
    const dpr = this.#dpr;
    const theme = this.#theme;
    // A combo's caps (a Graphics and a Text texture each) are built once and drawn on every frame
    // it shows; the previous combo's are destroyed, never left for the GPU to collect.
    const combo = k.keys.join("+");
    if (combo !== this.#keycapsLabel) {
      for (const old of this.#keycaps.removeChildren()) old.destroy({ children: true });
      let x = 0;
      for (const key of k.keys) {
        const text = label(theme, dpr, 13, "600");
        text.text = key;
        const w = Math.max(KEY_H, Math.ceil(text.width + 18));
        const g = new Graphics();
        softShadow(g, w, KEY_H, KEY_R, 12, 4, theme.shadeCursor);
        glassFace(g, w, KEY_H, KEY_R, theme);
        bottomBevel(g, w, KEY_H, KEY_R, 2).fill({
          color: theme.keyBevel.color,
          alpha: theme.keyBevel.alpha,
        });
        text.position.set((w - text.width) / 2, (KEY_H - text.height) / 2);
        const cap = new Container();
        cap.addChild(g, text);
        cap.position.set(x, 0);
        x += w + 6;
        this.#keycaps.addChild(cap);
      }
      this.#keycapsLabel = combo;
      this.#keycapsWidth = x - 6;
    }
    this.#keycaps.scale.set(dpr * k.scale);
    this.#keycaps.alpha = k.alpha;
    this.#keycaps.position.set(
      this.#viewport.w / 2 - (this.#keycapsWidth * dpr * k.scale) / 2,
      this.#viewport.h - (46 + KEY_H * k.scale - k.dy) * dpr,
    );
  }

  #drawCancel(c: CancelScene): void {
    this.#nameChip.visible = false;
    this.#placeChip(this.#cancelChip, c.text, c.x, c.y, c.dx);
    this.#cancelChip.alpha = c.alpha;
  }
}
