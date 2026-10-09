export interface Frameable {
  readonly root: Element;
  // Cleared while the view is scrolled away or hidden.
  visible: boolean;
  // Renders if it needs to, and says how long until it next needs a frame (0 or nothing: the next).
  frame(t: number): number | undefined;
}

// One requestAnimationFrame loop for every live dot. A view decides on each frame whether it needs
// to render; views off screen and hidden tabs get no frames at all, and while every view is calm
// the loop sleeps until the first one needs a frame again.
const views = new Set<Frameable>();
let raf = 0;
let sleeping: ReturnType<typeof setTimeout> | undefined;
let observer: IntersectionObserver | null = null;
let listening = false;
// A shorter wait than this is not worth a timer.
const SLEEP_MIN_MS = 20;

export const now = (): number => performance.now();

export function addView(view: Frameable): void {
  views.add(view);
  if (!listening) {
    listening = true;
    document.addEventListener("visibilitychange", kick);
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          for (const v of views) if (v.root === entry.target) v.visible = entry.isIntersecting;
        }
        kick();
      });
    }
  }
  observer?.observe(view.root);
  kick();
}

export function removeView(view: Frameable): void {
  views.delete(view);
  observer?.unobserve(view.root);
}

// Something changed: the views get the next display frame.
export function kick(): void {
  if (raf || document.hidden) return;
  for (const view of views) {
    if (view.visible) {
      clearTimeout(sleeping);
      sleeping = undefined;
      raf = requestAnimationFrame(frame);
      return;
    }
  }
}

function frame(): void {
  raf = 0;
  if (document.hidden) return;
  const t = now();
  let wait = Number.POSITIVE_INFINITY;
  for (const view of views) if (view.visible) wait = Math.min(wait, view.frame(t) ?? 0);
  if (wait < SLEEP_MIN_MS) kick();
  else if (Number.isFinite(wait)) sleeping = setTimeout(kick, wait);
}
