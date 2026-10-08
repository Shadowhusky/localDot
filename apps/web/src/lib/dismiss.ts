// An Escape that a native picker or a listbox hands back to the page still belongs to that
// control, so a sheet around it must not treat it as a request to close.
export function ownedByPicker(event: KeyboardEvent): boolean {
  const target = event.target;
  return (
    event.defaultPrevented ||
    (target instanceof Element && (target.matches("select") || !!target.closest("[role=listbox]")))
  );
}
