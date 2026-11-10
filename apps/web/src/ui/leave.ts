import { afterMotion } from "./finished.ts";
import { closeGap } from "./flip.ts";
import { tabbables } from "./focus.ts";
import { matches, REDUCED_MOTION } from "./media.ts";
import { tokenMs } from "./motion.ts";

export interface LeaveOptions {
  // What fades: those of `rows` on show, and any heading that goes with them. The rest just go.
  shown?: readonly HTMLElement[];
  // How long each shown row waits before it fades, by its place among them.
  delayOf?(index: number): number;
  // How long the rows are kept before they go; by default until they have faded.
  hold?: number;
  // Once they have gone.
  after?(): void;
}

// Rows leaving a list that can be long: each fades where it stands, inert, then `remove` takes them
// from the state in one commit and the rest glide up (closeGap). A row that is still there after
// that comes back whole.
export function leaveRows(
  rows: readonly HTMLElement[],
  remove: () => void,
  { shown = rows, delayOf, hold, after }: LeaveOptions = {},
): void {
  const first = shown[0];
  if (!first || typeof first.animate !== "function") {
    closeGap(rows, remove);
    after?.();
    return;
  }
  const fade = tokenMs(getComputedStyle(first), "--dur-fade", 150);
  const fading = shown.map((row, index) => {
    row.inert = true;
    row.dataset.leaving = "";
    return row.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: fade,
      delay: delayOf?.(index) ?? 0,
      easing: "ease-out",
      fill: "forwards",
    });
  });
  window.setTimeout(() => {
    closeGap(rows, remove);
    for (const row of shown) {
      if (!row.isConnected) continue;
      row.inert = false;
      delete row.dataset.leaving;
    }
    for (const animation of fading) animation.cancel();
    after?.();
  }, hold ?? fade);
}

function lostFocus(row: HTMLElement): boolean {
  const active = document.activeElement;
  return !active || active === document.body || row.contains(active);
}

// One row leaving a short list once its removal is sure: it fades and folds up, the list closing
// behind it, and focus that was in it moves to a neighbour. A short list can afford the layout; a
// long one takes leaveRows. Resolves when the row can go.
export function foldAway(row: Element | null | undefined): Promise<void> {
  if (!(row instanceof HTMLElement) || typeof row.animate !== "function") return Promise.resolve();
  const style = getComputedStyle(row);
  const gap = Number.parseFloat(
    row.parentElement ? getComputedStyle(row.parentElement).rowGap : "",
  );
  const closes = row.nextElementSibling ? "marginBottom" : "marginTop";
  const whole = {
    height: `${row.offsetHeight}px`,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    marginTop: style.marginTop,
    marginBottom: style.marginBottom,
    opacity: 1,
  };
  const frames: Keyframe[] = matches(REDUCED_MOTION)
    ? [{ opacity: 1 }, { opacity: 0 }]
    : [
        whole,
        {
          height: "0px",
          paddingTop: "0px",
          paddingBottom: "0px",
          marginTop: "0px",
          marginBottom: "0px",
          [closes]: `${-(gap || 0)}px`,
          opacity: 0,
        },
      ];
  row.inert = true;
  row.style.overflow = "hidden";
  row.animate(frames, {
    duration: tokenMs(style, "--dur-snappy", 340),
    easing: style.getPropertyValue("--ease-standard").trim() || "ease-out",
    fill: "forwards",
  });
  const next = row.nextElementSibling;
  const before = row.previousElementSibling;
  return new Promise((resolve) => {
    afterMotion(
      [row],
      () => {
        if (lostFocus(row)) {
          const neighbour = [next, before].flatMap((each) =>
            each instanceof HTMLElement ? tabbables(each) : [],
          )[0];
          neighbour?.focus({ preventScroll: true });
        }
        resolve();
      },
      false,
    );
  });
}
