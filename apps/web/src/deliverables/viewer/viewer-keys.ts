// Whether a key pressed with focus on `target` is the viewer's to act on: pressed in the viewer's
// sheet or with nothing focused, and not in a field or a control that uses the arrows itself.
export function viewerHears(host: HTMLElement | null, target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (
    !host ||
    (element && element !== document.body && !host.closest(".ui-sheet")?.contains(element))
  )
    return false;
  return !element?.closest(
    "input, textarea, select, [contenteditable], [role=radiogroup], [role=tablist], [role=slider], video, audio",
  );
}
