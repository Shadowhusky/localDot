// Room between dot and its words, and below the site's bar.
const GAP = 14;
const BAR = 72;
// How far above dot's centre its tallest hat reaches, in radii.
const HAT = 1.35;

// Whether dot's words fit above its head, below the site's bar.
export function lineAbove(at: { y: number; r: number; height: number; top: number }): boolean {
  return at.y - at.r * HAT - GAP - at.height >= at.top;
}

export function nextLine(lines: readonly string[], n: number): string {
  return lines[n % lines.length] ?? "";
}

// Pressing dot in the studio: a round button over it, and the line it says in reply.
export class Poke {
  private said = 0;
  private timer = 0;
  private at = { x: 0, y: 0, r: 0, width: 0 };
  private size = { width: 0, height: 0 };

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly bubble: HTMLElement,
    onPress: () => void,
  ) {
    button.addEventListener("click", onPress);
  }

  // The next of a dot's lines to say.
  next(lines: readonly string[]): string {
    return nextLine(lines, this.said++);
  }

  // Shows what dot says for `ms`.
  show(text: string, ms: number): void {
    this.bubble.textContent = text;
    this.bubble.dataset.shown = "";
    this.size = { width: this.bubble.offsetWidth, height: this.bubble.offsetHeight };
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => delete this.bubble.dataset.shown, ms);
    this.layout();
  }

  // dot's centre and radius in stage pixels, the stage's width, and whether dot can be pressed.
  place(x: number, y: number, r: number, width: number, shown: boolean): void {
    if (this.button.hidden === shown) this.button.hidden = !shown;
    if (!shown) {
      delete this.bubble.dataset.shown;
      return;
    }
    this.button.style.transform = `translate(${(x - r).toFixed(1)}px, ${(y - r).toFixed(1)}px)`;
    this.button.style.width = this.button.style.height = `${(2 * r).toFixed(1)}px`;
    this.at = { x, y, r, width };
    if ("shown" in this.bubble.dataset) this.layout();
  }

  private layout(): void {
    const { x, y, r, width } = this.at;
    const { width: w, height } = this.size;
    const left = Math.min(Math.max(x - w / 2, GAP), width - w - GAP);
    const top = lineAbove({ y, r, height, top: BAR }) ? y - r * HAT - GAP - height : y + r + GAP;
    this.bubble.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
  }
}
