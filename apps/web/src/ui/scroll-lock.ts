let locks = 0;
let saved: { overflow: string; paddingRight: string } | undefined;

// Stops the page scrolling under a modal layer. It writes inline styles through the CSSOM, which the
// page's CSP allows (a <style> element would be blocked), and pads the body by the width of the
// scrollbar it hides so nothing behind the layer moves.
export function lockScroll(): () => void {
  if (locks++ === 0) {
    const root = document.documentElement;
    const { body } = document;
    const scrollbar = window.innerWidth - root.clientWidth;
    saved = { overflow: root.style.overflow, paddingRight: body.style.paddingRight };
    if (scrollbar > 0) {
      const padding = Number.parseFloat(getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${padding + scrollbar}px`;
    }
    root.style.overflow = "hidden";
    root.dataset.scrollLocked = "";
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks > 0 || !saved) return;
    const root = document.documentElement;
    root.style.overflow = saved.overflow;
    document.body.style.paddingRight = saved.paddingRight;
    delete root.dataset.scrollLocked;
    saved = undefined;
  };
}
