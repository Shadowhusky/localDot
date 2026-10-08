// Past this, a transition that never reports (a hidden tab, a cancelled frame) is not waited for.
const LIMIT = 1000;

function moving(element: Element | null | undefined, subtree: boolean): Animation[] {
  if (typeof element?.getAnimations !== "function") return [];
  return element
    .getAnimations({ subtree })
    .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
}

// Calls done once what is moving in these elements now has stopped, however it stopped: at once when
// nothing moves, and after a limit if something never reports. A spinner, which never ends, is not
// waited for. Returns a cancel.
export function afterMotion(
  elements: readonly (Element | null | undefined)[],
  done: () => void,
  subtree = true,
): () => void {
  const running = elements.flatMap((element) => moving(element, subtree));
  if (running.length === 0) {
    done();
    return () => {};
  }
  let waiting = true;
  const finish = () => {
    if (!waiting) return;
    waiting = false;
    window.clearTimeout(limit);
    done();
  };
  const limit = window.setTimeout(finish, LIMIT);
  void Promise.allSettled(running.map((animation) => animation.finished)).then(finish);
  return () => {
    waiting = false;
    window.clearTimeout(limit);
  };
}
