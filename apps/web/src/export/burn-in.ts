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
const BOTTOM = 32;
const TEXT_W = 880;
const CAPTION_CHARS = 60;
const CHIP_ALPHA = 0.92;

// What the one chip says: why nothing was recorded during a gap, else the step under way and how
// fast it plays.
export function burnInText(
  label: string | null,
  caption: string | null,
  gap: RecordingGapReason | null,
): string | null {
  const card = gap ? gapCard(gap) : null;
  if (card) return `${card.title}\n${card.body}`;
  const parts = [caption && clipText(caption, CAPTION_CHARS), label].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

// One caption chip, bottom-centre on the HUD's solid material, in the interface's own typeface.
export class ExportBurnIn extends Container {
  readonly #chip = new Graphics();
  readonly #text: Text;
  readonly #theme: StageTheme;
  readonly #height: number;

  constructor(theme: StageTheme, width: number, height: number) {
    super();
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

  draw(label: string | null, caption: string | null, gap: RecordingGapReason | null): void {
    const text = burnInText(label, caption, gap);
    this.visible = text !== null;
    if (text === null || this.#text.text === text) return;
    this.#text.text = text;
    const width = this.#text.width + PAD_X * 2;
    const height = this.#text.height + PAD_Y * 2;
    const left = Math.round((LAYOUT_W - width) / 2);
    const top = Math.round(this.#height - BOTTOM - height);
    this.#text.position.set(left + PAD_X, top + PAD_Y);
    this.#chip
      .clear()
      .roundRect(left, top, width, height, RADIUS)
      .fill({ color: this.#theme.hudSolid.color, alpha: CHIP_ALPHA });
  }
}
