import { flushSync } from "react-dom";

type ViewTransitions = Document & {
  startViewTransition?(update: () => void): { finished: Promise<void> };
};

let latest = 0;

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
