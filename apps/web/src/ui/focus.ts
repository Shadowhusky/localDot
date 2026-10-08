const CANDIDATES = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable]:not([contenteditable=false])",
  "[tabindex]",
].join(",");

// Where checkVisibility is missing (Safari before 17.4, test DOMs) only the attributes are checked.
function shown(element: HTMLElement): boolean {
  if (element.closest("[hidden], [inert]")) return false;
  return typeof element.checkVisibility !== "function" || element.checkVisibility();
}

// What Tab reaches inside a container, in order. Of a group of radios only the checked one counts
// (or the first, when none is), as the browser tabs.
export function tabbables(container: HTMLElement): HTMLElement[] {
  const seen = new Set<string>();
  return [...container.querySelectorAll<HTMLElement>(CANDIDATES)].filter((element) => {
    if (element.tabIndex < 0 || !shown(element)) return false;
    if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name)
      return true;
    const group = `${element.form?.id ?? ""}/${element.name}`;
    if (seen.has(group)) return false;
    const checked = container.querySelector<HTMLInputElement>(
      `input[type=radio][name="${CSS.escape(element.name)}"]:checked`,
    );
    if (checked && checked !== element) return false;
    seen.add(group);
    return true;
  });
}

const FIELDS = "input:not([type=hidden]), textarea, select, [contenteditable]";

export function firstField(container: HTMLElement): HTMLElement | undefined {
  return tabbables(container).find((element) => element.matches(FIELDS));
}

// Focus may go back only to an element that is still on the page and can take it.
export function canFocus(element: Element | null | undefined): element is HTMLElement {
  return element instanceof HTMLElement && element.isConnected && shown(element);
}

export function focusWithoutScroll(element: HTMLElement) {
  element.focus({ preventScroll: true });
}
