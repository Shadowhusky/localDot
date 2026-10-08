import { clipText, type RecordingGapReason } from "@localdot/protocol";
import { Container, Graphics, Text } from "pixi.js";
import { gapCard } from "../replay/replay-view.ts";
import type { StageTheme } from "../stage/theme.ts";

class ExportChip extends Container {
  readonly background = new Graphics();
  readonly text: Text;
  readonly #theme: StageTheme;

  constructor(theme: StageTheme, fontSize: number, maxWidth: number) {
    super();
    this.#theme = theme;
    this.text = new Text({
      text: "",
      style: {
        fontFamily: "Arial, sans-serif",
        fontSize,
        fill: theme.text.color,
        wordWrap: true,
        wordWrapWidth: maxWidth,
        align: "center",
      },
    });
    this.text.alpha = theme.text.alpha;
    this.addChild(this.background, this.text);
  }

  set(label: string | null): void {
    this.visible = !!label;
    if (!label || this.text.text === label) return;
    this.text.text = label;
    this.text.position.set(14, 10);
    this.background
      .clear()
      .roundRect(0, 0, this.text.width + 28, this.text.height + 20, 10)
      .fill(this.#theme.hudSolid)
      .stroke({ ...this.#theme.hudLine, width: 1 });
  }
}

export class ExportBurnIn extends Container {
  readonly #label: ExportChip;
  readonly #caption: ExportChip;
  readonly #gap: ExportChip;
  readonly #width: number;
  readonly #height: number;

  constructor(theme: StageTheme, width: number, height: number) {
    super();
    const scale = width / 1280;
    this.scale.set(scale);
    this.#width = width / scale;
    this.#height = height / scale;
    this.#label = new ExportChip(theme, 14, 420);
    this.#caption = new ExportChip(theme, 18, 880);
    this.#gap = new ExportChip(theme, 20, 580);
    this.addChild(this.#gap, this.#caption, this.#label);
  }

  draw(label: string | null, caption: string | null, gap: RecordingGapReason | null): void {
    this.#label.set(label);
    this.#label.position.set(16, this.#height - 16 - this.#label.height);
    this.#caption.set(caption ? clipText(caption, 60) : null);
    this.#caption.position.set(
      (this.#width - this.#caption.width) / 2,
      this.#height - 64 - this.#caption.height,
    );
    const card = gap ? gapCard(gap) : null;
    this.#gap.set(card ? `${card.title}\n${card.body}` : null);
    this.#gap.position.set(
      (this.#width - this.#gap.width) / 2,
      (this.#height - this.#gap.height) / 2,
    );
  }
}
