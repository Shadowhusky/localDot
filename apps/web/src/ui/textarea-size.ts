// Imperative edits (paste, dictation, clearing a sent draft) need the same resize as native input.
const resizers = new WeakMap<HTMLTextAreaElement, () => void>();
export function resizeTextArea(area: HTMLTextAreaElement): void {
  resizers.get(area)?.();
}

const METRICS = [
  "box-sizing",
  "width",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "direction",
  "text-indent",
  "text-transform",
  "tab-size",
  "word-break",
  "overflow-wrap",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
] as const;

// Older Safari cannot size a textarea to its content. Measure an isolated, invisible field:
// collapsing the focused field on every input forces page layout and moves the keyboard's caret.
export function observeTextAreaSize(area: HTMLTextAreaElement): () => void {
  const mirror = document.createElement("textarea");
  mirror.setAttribute("aria-hidden", "true");
  mirror.tabIndex = -1;
  mirror.readOnly = true;
  mirror.style.cssText =
    "position:fixed;top:0;left:0;height:0;min-height:0;max-height:none;margin:0;visibility:hidden;pointer-events:none;overflow:hidden;contain:strict;field-sizing:fixed;border-style:solid;";
  document.body.append(mirror);
  let frame = 0;
  let disposed = false;
  const fit = () => {
    frame = 0;
    if (disposed || !area.isConnected || !area.getClientRects().length) return;
    const css = getComputedStyle(area);
    for (const metric of METRICS) mirror.style.setProperty(metric, css.getPropertyValue(metric));
    // An empty field stays one line, regardless of its placeholder's length.
    mirror.style.whiteSpace = area.value ? css.whiteSpace : "pre-wrap";
    mirror.wrap = area.wrap;
    mirror.value = area.value || " ";
    const padding = Number.parseFloat(css.paddingTop) + Number.parseFloat(css.paddingBottom);
    const border = Number.parseFloat(css.borderTopWidth) + Number.parseFloat(css.borderBottomWidth);
    const height = mirror.scrollHeight + (css.boxSizing === "border-box" ? border : -padding);
    // Drafts and credentials have one owner. The measuring field keeps no copy between frames.
    mirror.value = "";
    const minimum = Number.parseFloat(css.minHeight) || 0;
    const maximum = Number.parseFloat(css.maxHeight) || Number.POSITIVE_INFINITY;
    const next = `${Math.max(minimum, Math.min(maximum, height))}px`;
    if (area.style.height !== next) area.style.height = next;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(fit);
  };
  // Width and font changes (rotation, panel resizing, text scaling) also change wrapping.
  let width = -1;
  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          const next = entries[0]?.contentRect.width;
          if (next !== undefined && next !== width) {
            width = next;
            schedule();
          }
        });
  observer?.observe(area);
  area.addEventListener("input", schedule);
  resizers.set(area, schedule);
  window.addEventListener("resize", schedule);
  document.fonts?.addEventListener("loadingdone", schedule);
  fit();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    area.removeEventListener("input", schedule);
    resizers.delete(area);
    window.removeEventListener("resize", schedule);
    document.fonts?.removeEventListener("loadingdone", schedule);
    mirror.value = "";
    mirror.remove();
  };
}
