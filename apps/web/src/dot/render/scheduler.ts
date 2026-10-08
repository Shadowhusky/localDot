export interface Frameable {
  readonly root: Element;
  // Cleared while the view is scrolled away or hidden.
  visible: boolean;
  frame(t: number): void;
}

// One requestAnimationFrame loop for every live dot. A view decides on each frame whether it needs
// to render; views off screen and hidden tabs get no frames at all.
const views = new Set<Frameable>();
let raf = 0;
let observer: IntersectionObserver | null = null;
let listening = false;

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

function kick(): void {
  if (raf || document.hidden) return;
  for (const view of views) {
    if (view.visible) {
      raf = requestAnimationFrame(frame);
      return;
    }
  }
}

function frame(): void {
  raf = 0;
  if (document.hidden) return;
  const t = now();
  for (const view of views) if (view.visible) view.frame(t);
  kick();
}
