import { flushSync } from "react-dom";
import { matches, REDUCED_MOTION } from "../ui/media.ts";

type ViewTransitions = Document & {
  startViewTransition?(update: () => void): { finished: Promise<void> };
};

let latest = 0;

// One whole layout fading into another, as when the view style changes. With reduced motion or
// without view transitions it changes at once.
export function changeCalmly(update: () => void): void {
  const page = document as ViewTransitions;
  if (
    typeof page.startViewTransition !== "function" ||
    document.hidden ||
    matches(REDUCED_MOTION)
  ) {
    update();
    return;
  }
  try {
    page.startViewTransition(() => flushSync(update));
  } catch {
    update();
  }
}

// Taking up another conversation under a view transition: the thread it leaves slides out the way
// the list moves (`data-switch` on the root: "down" for one lower in the list) and the new one
// comes in behind it, while the rest of the page stays live (rails.css). Without view transitions,
// or on a hidden page, it changes at once.
export function switchConversation(update: () => void, direction: "up" | "down"): void {
  const page = document as ViewTransitions;
  if (typeof page.startViewTransition !== "function" || document.hidden) {
    update();
    return;
  }
  const root = document.documentElement;
  const turn = ++latest;
  root.dataset.switch = direction;
  const done = () => {
    if (turn === latest) delete root.dataset.switch;
  };
  try {
    page.startViewTransition(() => flushSync(update)).finished.then(done, done);
  } catch {
    done();
    update();
  }
}
