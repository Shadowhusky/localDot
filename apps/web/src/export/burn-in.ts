import { clipText, type RecordingGapReason } from "@localdot/protocol";
import { Container, Graphics, Text } from "pixi.js";
import { gapCard } from "../replay/replay-view.ts";
import type { StageTheme } from "../stage/theme.ts";

// Laid out at 1280 px wide and scaled with the video.
const LAYOUT_W = 1280;
const FONT_SIZE = 20;
const LINE_HEIGHT = 26;
const PAD_X = 16;
const PAD_Y = 10;
const RADIUS = 12;
const EDGE = 32;
const TEXT_W = 880;
const CAPTION_CHARS = 60;
const CHIP_ALPHA = 0.92;

// What the one chip says: why nothing was recorded during a gap, else the step under way when the
// viewer asked for it.
export function burnInText(caption: string | null, gap: RecordingGapReason | null): string | null {
  const card = gap ? gapCard(gap) : null;
  if (card) return `${card.title}\n${card.body}`;
  return caption ? clipText(caption, CAPTION_CHARS) : null;
}

// One caption chip, centred on the HUD's solid material, in the interface's own typeface: at the
// picture's foot, or at its head while dot and its words sit in the foot's corner.
export class ExportBurnIn extends Container {
  readonly #chip = new Graphics();
  readonly #text: Text;
  readonly #theme: StageTheme;
  readonly #height: number;
  readonly #place: "foot" | "head";

  constructor(theme: StageTheme, width: number, height: number, place: "foot" | "head" = "foot") {
    super();
    this.#place = place;
    const scale = width / LAYOUT_W;
    this.scale.set(scale);
    this.#height = height / scale;
    this.#theme = theme;
    this.#text = new Text({
      text: "",
      style: {
        fontFamily: theme.font,
        fontSize: FONT_SIZE,
        fontWeight: "500",
        lineHeight: LINE_HEIGHT,
        fill: theme.text.color,
        wordWrap: true,
        wordWrapWidth: TEXT_W,
        align: "center",
      },
    });
    this.#text.alpha = theme.text.alpha;
    this.addChild(this.#chip, this.#text);
    this.visible = false;
  }

  draw(caption: string | null, gap: RecordingGapReason | null): void {
    const text = burnInText(caption, gap);
    this.visible = text !== null;
    if (text === null || this.#text.text === text) return;
    this.#text.text = text;
    const width = this.#text.width + PAD_X * 2;
    const height = this.#text.height + PAD_Y * 2;
    const left = Math.round((LAYOUT_W - width) / 2);
    const top = Math.round(this.#place === "head" ? EDGE : this.#height - EDGE - height);
    this.#text.position.set(left + PAD_X, top + PAD_Y);
    this.#chip
      .clear()
      .roundRect(left, top, width, height, RADIUS)
      .fill({ color: this.#theme.hudSolid.color, alpha: CHIP_ALPHA });
  }
}
