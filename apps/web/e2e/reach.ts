// How far a control takes a touch, each way: its box, or the larger reach drawn around it, capped
// at the 44 px a finger needs.
export function reach(control: Element) {
  const box = control.getBoundingClientRect();
  const own = getComputedStyle(control);
  const around = getComputedStyle(control, "::after");
  const drawn = around.content !== "none" && around.position === "absolute";
  const across = (size: number, start: string, end: string, edges: number) =>
    Math.min(
      44,
      Math.round(
        Math.max(
          size,
          drawn ? size - edges - Number.parseFloat(start) - Number.parseFloat(end) : 0,
        ),
      ),
    );
  return {
    width: across(
      box.width,
      around.left,
      around.right,
      Number.parseFloat(own.borderLeftWidth) + Number.parseFloat(own.borderRightWidth),
    ),
    height: across(
      box.height,
      around.top,
      around.bottom,
      Number.parseFloat(own.borderTopWidth) + Number.parseFloat(own.borderBottomWidth),
    ),
  };
}
