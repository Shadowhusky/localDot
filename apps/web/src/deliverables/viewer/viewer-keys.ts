type Key = Pick<KeyboardEvent, "key" | "target">;

// Space and Enter press a focused button or link instead.
export function pressesControl({ key, target }: Key): boolean {
  return (
    (key === " " || key === "Enter") &&
    target instanceof Element &&
    target.closest("button, a[href], [role=button], summary") !== null
  );
}

// Whether a key pressed with focus on its target is the viewer's to act on: pressed in the viewer's
// sheet or with nothing focused, and not in a field, a control that uses the arrows itself, or on a
// button that Space and Enter press.
export function viewerHears(host: HTMLElement | null, event: Key): boolean {
  const element = event.target instanceof Element ? event.target : null;
  if (
    !host ||
    (element && element !== document.body && !host.closest(".ui-sheet")?.contains(element))
  )
    return false;
  return (
    !pressesControl(event) &&
    !element?.closest(
      "input, textarea, select, [contenteditable], [role=radiogroup], [role=tablist], [role=slider], video, audio",
    )
  );
}
