import type {
  Camera,
  CancelScene,
  CursorScene,
  DragScene,
  KeycapsScene,
  RingScene,
  Scene,
  TargetScene,
  TypingScene,
} from "@localdot/stage";
import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { CURSOR_TILT_RAD, cursorPolygon, ringRadius } from "./geometry.ts";
import type { StageTheme, ThemeColor } from "./theme.ts";

class Chip extends Container {
  readonly bg = new Graphics();
  readonly text: Text;
  constructor(theme: StageTheme, dpr: number, size: number, fill: ThemeColor) {
    super();
    this.text = new Text({
      text: "",
      style: new TextStyle({
        fontFamily: theme.font,
        fontSize: size,
        fontWeight: "500",
        fill: fill.color,
      }),
      resolution: dpr,
    });
    this.addChild(this.bg, this.text);
    this.setTheme(theme);
  }
  setTheme(theme: StageTheme) {
    this.bgColor = theme.hudSolid;
  }
  bgColor: ThemeColor = { color: 0, alpha: 0.92 };
  set(label: string, padX = 8, height = 19): void {
    this.text.text = label;
    const w = this.text.width + padX * 2;
    this.text.position.set(padX, (height - this.text.height) / 2);
    this.bg
      .clear()
      .roundRect(0, 0, w, height, height / 2)
      .fill({ color: this.bgColor.color, alpha: this.bgColor.alpha });
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
  #viewport = { w: 1, h: 1 };
  readonly #targetG = new Graphics();
  readonly #ringsG = new Graphics();
  readonly #dragG = new Graphics();
  readonly #cursor = new Container();
  readonly #cursorG = new Graphics();
  readonly #nameChip: Chip;
  readonly #targetChip: Chip;
  readonly #typing = new Container();
  readonly #typingBg = new Graphics();
  readonly #typingText: Text;
  readonly #typingMore: Text;
  readonly #caret = new Graphics();
  readonly #cancelChip: Chip;
  readonly #keycaps = new Container();
  #keycapsLabel = "";
  #keycapsWidth = 0;

  constructor(theme: StageTheme, dpr: number) {
    this.#theme = theme;
    this.#dpr = dpr;
    this.#nameChip = new Chip(theme, dpr, 11, theme.text);
    this.#targetChip = new Chip(theme, dpr, 11, theme.text);
    this.#cancelChip = new Chip(theme, dpr, 11, theme.text);
    this.#typingText = new Text({
      text: "",
      style: new TextStyle({
        fontFamily: theme.font,
        fontSize: 14,
        fontWeight: "500",
        fill: theme.text.color,
      }),
      resolution: dpr,
    });
    this.#typingMore = new Text({
      text: "",
      style: new TextStyle({ fontFamily: theme.font, fontSize: 11, fill: theme.text2.color }),
      resolution: dpr,
    });
    this.#typing.addChild(this.#typingBg, this.#typingText, this.#typingMore, this.#caret);
    this.#cursor.addChild(this.#cursorG, this.#nameChip);
    this.world.addChild(
      this.#targetG,
      this.#dragG,
      this.#ringsG,
      this.#targetChip,
      this.#typing,
      this.#cancelChip,
      this.#cursor,
    );
    this.screen.addChild(this.#keycaps);
  }

  setTheme(theme: StageTheme): void {
    this.#theme = theme;
    for (const c of [this.#nameChip, this.#targetChip, this.#cancelChip]) c.setTheme(theme);
    this.#keycapsLabel = "";
  }

  setCamera(cam: Camera): void {
    this.#unit = this.#dpr / cam.scale;
  }

  setViewport(w: number, h: number): void {
    this.#viewport = { w, h };
  }

  draw(scene: Scene | null): void {
    this.#targetG.clear();
    this.#dragG.clear();
    this.#ringsG.clear();
    this.#cursor.visible = false;
    this.#targetChip.visible = false;
    this.#typing.visible = false;
    this.#cancelChip.visible = false;
    this.#keycaps.visible = false;
    if (!scene) return;
    if (scene.target) this.#drawTarget(scene.target, scene.control);
    if (scene.drag) this.#drawDrag(scene.drag, scene.control);
    for (const ring of scene.rings) this.#drawRing(ring, scene.control);
    if (scene.cursor?.visible) this.#drawCursor(scene.cursor, scene.control);
    if (scene.typing) this.#drawTyping(scene.typing, scene.control);
    if (scene.keycaps) this.#drawKeycaps(scene.keycaps);
    if (scene.cancel) this.#drawCancel(scene.cancel);
  }

  // Xenon only while the agent has control; a neutral outline otherwise (Theatre).
  #accent(control: boolean): ThemeColor {
    return control ? this.#theme.xenon : this.#theme.text2;
  }

  #drawTarget(t: TargetScene, control: boolean): void {
    const u = this.#unit;
    const g = this.#targetG;
    const accent = this.#accent(control);
    if (t.rect) {
      const pad = 3 * u;
      const r = {
        x: t.rect.x - pad,
        y: t.rect.y - pad,
        w: t.rect.w + 2 * pad,
        h: t.rect.h + 2 * pad,
      };
      if (t.style === "acting") {
        g.roundRect(r.x, r.y, r.w, r.h, 4 * u).stroke({
          width: 2.5 * u,
          color: this.#theme.haloTarget.color,
          alpha: this.#theme.haloTarget.alpha * t.alpha,
          alignment: 1,
        });
        g.roundRect(r.x, r.y, r.w, r.h, 4 * u)
          .fill({
            color: this.#theme.xenonA10.color,
            alpha: this.#theme.xenonA10.alpha * t.alpha * (control ? 1 : 0),
          })
          .stroke({ width: 1.5 * u, color: accent.color, alpha: t.alpha });
      } else {
        this.#dashedRect(g, r, 6 * u, accent, t.alpha);
      }
      if (t.chip) {
        this.#targetChip.visible = true;
        this.#targetChip.set(t.chip);
        this.#targetChip.alpha = t.alpha;
        this.#targetChip.scale.set(u);
        const above = r.y - 24 * u;
        this.#targetChip.position.set(r.x, above < 0 ? r.y + r.h + 5 * u : above);
      }
    } else {
      // Coordinates only: the localization marker (36 px ring, crosshair, centre dot).
      const rr = 18 * u;
      g.circle(t.point.x, t.point.y, rr)
        .fill({
          color: this.#theme.xenonA10.color,
          alpha: this.#theme.xenonA10.alpha * t.alpha * (control ? 1 : 0),
        })
        .stroke({ width: 1.5 * u, color: accent.color, alpha: t.alpha });
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        g.moveTo(t.point.x + dx * (rr - 4 * u), t.point.y + dy * (rr - 4 * u))
          .lineTo(t.point.x + dx * (rr + 6 * u), t.point.y + dy * (rr + 6 * u))
          .stroke({ width: 1.5 * u, color: accent.color, alpha: t.alpha });
      }
      g.circle(t.point.x, t.point.y, 2 * u).fill({ color: accent.color, alpha: t.alpha });
    }
  }

  // The way a held button has gone: a line over a soft halo that keeps it legible on any screen.
  #drawDrag(drag: DragScene, control: boolean): void {
    const u = this.#unit;
    const g = this.#dragG;
    const [start, ...rest] = drag.points;
    if (!start) return;
    const line = (width: number, color: ThemeColor) => {
      g.moveTo(start.x, start.y);
      for (const p of rest) g.lineTo(p.x, p.y);
      g.stroke({
        width: width * u,
        color: color.color,
        alpha: color.alpha * drag.alpha,
        cap: "round",
        join: "round",
      });
    };
    line(6, this.#theme.haloTarget);
    line(2.5, this.#accent(control));
    g.circle(start.x, start.y, 3.5 * u).fill({
      color: this.#accent(control).color,
      alpha: drag.alpha,
    });
  }

  #dashedRect(
    g: Graphics,
    r: { x: number; y: number; w: number; h: number },
    dash: number,
    c: ThemeColor,
    alpha: number,
  ): void {
    const edges: [number, number, number, number][] = [
      [r.x, r.y, r.x + r.w, r.y],
      [r.x + r.w, r.y, r.x + r.w, r.y + r.h],
      [r.x + r.w, r.y + r.h, r.x, r.y + r.h],
      [r.x, r.y + r.h, r.x, r.y],
    ];
    for (const [x0, y0, x1, y1] of edges) {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(1, Math.floor(len / (dash * 2)));
      for (let i = 0; i < n; i++) {
        const a = i / n;
        const b = Math.min(1, a + dash / len);
        g.moveTo(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a)
          .lineTo(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b)
          .stroke({ width: 1.5 * this.#unit, color: c.color, alpha });
      }
    }
  }

  #drawRing(ring: RingScene, control: boolean): void {
    const u = this.#unit;
    const { outer, alpha } = ringRadius(ring.p);
    const accent = this.#accent(control);
    const g = this.#ringsG;
    if (ring.style === "right") {
      for (let i = 0; i < 12; i++) {
        const a0 = (i / 12) * Math.PI * 2;
        g.arc(ring.x, ring.y, outer * u, a0, a0 + Math.PI / 18).stroke({
          width: 2 * u,
          color: accent.color,
          alpha,
        });
        g.moveTo(
          ring.x + Math.cos(a0 + Math.PI / 6) * outer * u,
          ring.y + Math.sin(a0 + Math.PI / 6) * outer * u,
        );
      }
    } else {
      g.circle(ring.x, ring.y, outer * u).stroke({ width: 2 * u, color: accent.color, alpha });
    }
    g.circle(ring.x, ring.y, outer * 0.55 * u).stroke({
      width: 1.5 * u,
      color: accent.color,
      alpha: alpha * 0.5,
    });
  }

  #drawCursor(c: CursorScene, control: boolean): void {
    const u = this.#unit;
    this.#cursor.visible = true;
    this.#cursor.position.set(c.x, c.y);
    this.#cursor.alpha = c.alpha;
    const g = this.#cursorG;
    g.clear();
    const squash = 1 - 0.15 * c.press;
    g.rotation = CURSOR_TILT_RAD;
    g.scale.set(u * squash);
    // A soft dark halo under the arrow (the desktop is light), then rim, fill and the accent stroke.
    g.circle(7, 9, 9).fill({
      color: this.#theme.shadeCursor.color,
      alpha: this.#theme.shadeCursor.alpha * 0.45,
    });
    const pts = cursorPolygon(1);
    g.poly(pts, true).stroke({
      width: 2.6,
      color: this.#theme.cursorRim.color,
      alpha: this.#theme.cursorRim.alpha,
      alignment: 1,
      join: "round",
    });
    g.poly(pts, true).fill({
      color: this.#theme.cursorFill.color,
      alpha: this.#theme.cursorFill.alpha,
    });
    if (control)
      g.poly(pts, true).stroke({
        width: 2,
        color: this.#theme.xenon.color,
        alpha: this.#theme.xenon.alpha,
        alignment: 0,
        join: "round",
      });
    // The name chip sits below-right, clear of the arrow so the oracle can isolate the arrow.
    this.#nameChip.visible = true;
    this.#nameChip.scale.set(u);
    this.#nameChip.position.set(14 * u, 30 * u);
    if (c.chipAlpha > 0) {
      this.#nameChip.set(c.name, 8, 19);
      this.#nameChip.alpha = c.chipAlpha;
    } else {
      this.#nameChip.set("", 3, 6);
      this.#nameChip.alpha = 1;
    }
  }

  #drawTyping(t: TypingScene, control: boolean): void {
    const u = this.#unit;
    this.#typing.visible = true;
    this.#typing.scale.set(u);
    this.#typing.alpha = t.alpha;
    const label = t.more > 0 ? `${t.text}` : t.text;
    this.#typingText.text = `⌨ ${label}`;
    this.#typingMore.text = t.more > 0 ? `+${t.more} more` : "";
    const padX = 12;
    const h = 32;
    const w =
      padX + this.#typingText.width + (t.more > 0 ? 8 + this.#typingMore.width : 0) + 10 + padX;
    this.#typingBg
      .clear()
      .roundRect(0, 0, w, h, 16)
      .fill({ color: this.#theme.hudSolid.color, alpha: this.#theme.hudSolid.alpha })
      .stroke({
        width: 1,
        color: this.#theme.hudLine.color,
        alpha: this.#theme.hudLine.alpha,
        alignment: 0,
      });
    this.#typingText.position.set(padX, (h - this.#typingText.height) / 2);
    this.#typingMore.position.set(
      padX + this.#typingText.width + 8,
      (h - this.#typingMore.height) / 2,
    );
    this.#caret.clear();
    if (t.caretOn)
      this.#caret
        .rect(padX + this.#typingText.width + 2, 8, 2, 16)
        .fill({ color: this.#accent(control).color, alpha: 1 });
    const x = t.anchor.x - 4 * u;
    const y = t.anchor.y - (h + 33) * u;
    this.#typing.position.set(x, y < 0 ? t.anchor.y + 40 * u : y);
  }

  #drawKeycaps(k: KeycapsScene): void {
    this.#keycaps.visible = true;
    const dpr = this.#dpr;
    // A combo's chips (a Graphics and a Text texture each) are built once and drawn on every frame
    // it shows; the previous combo's are destroyed, never left for the GPU to collect.
    const label = k.keys.join("+");
    if (label !== this.#keycapsLabel) {
      for (const old of this.#keycaps.removeChildren()) old.destroy({ children: true });
      let x = 0;
      for (const key of k.keys) {
        const chip = new Chip(this.#theme, dpr, 13, this.#theme.text);
        chip.set(key, 9, 30);
        chip.bg
          .rect(0, 28, chip.bg.width, 2)
          .fill({ color: this.#theme.keyBevel.color, alpha: this.#theme.keyBevel.alpha });
        chip.position.set(x, 0);
        x += chip.bg.width + 6;
        this.#keycaps.addChild(chip);
      }
      this.#keycapsLabel = label;
      this.#keycapsWidth = x - 6;
    }
    this.#keycaps.scale.set(dpr * k.scale);
    this.#keycaps.alpha = k.alpha * 0.9;
    // `dy` lifts the chips 20 px into place while they pop in (research §4.3.6).
    this.#keycaps.position.set(
      this.#viewport.w / 2 - (this.#keycapsWidth * dpr * k.scale) / 2,
      this.#viewport.h - (46 + 30 * k.scale - k.dy) * dpr,
    );
  }

  #drawCancel(c: CancelScene): void {
    this.#cancelChip.visible = true;
    this.#cancelChip.scale.set(this.#unit);
    this.#cancelChip.set(`Blocked · ${c.reason}`);
    this.#cancelChip.alpha = c.alpha;
    this.#cancelChip.position.set(c.x + (14 + c.dx) * this.#unit, c.y + 52 * this.#unit);
  }
}
