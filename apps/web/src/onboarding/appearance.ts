// No React here: appearance-boot.ts bundles this alone to set the appearance before first paint.
export type Appearance = "graphite" | "midnight" | "daylight";
export type AppearanceChoice = Appearance | "system";
export type DarkAppearance = Exclude<Appearance, "daylight">;

export interface AppearanceState {
  choice: AppearanceChoice;
  // What System shows while the device is dark: the dark appearance chosen last.
  dark: DarkAppearance;
  saved: boolean;
}

export const APPEARANCE_KEY = "localdot.appearance.v1";
export const DARK_APPEARANCE_KEY = "localdot.appearance-dark.v1";
export const APPEARANCE_EVENT = "localdot-appearance-change";
export const APPEARANCE_CHOICES: readonly AppearanceChoice[] = [
  "graphite",
  "midnight",
  "daylight",
  "system",
];
const LIGHT_DEVICE = "(prefers-color-scheme: light)";

export const isDarkAppearance = (value: unknown): value is DarkAppearance =>
  value === "graphite" || value === "midnight";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Nothing saved, or a value no longer offered, is Graphite: the house before there was a choice,
// so a page nobody chose for does not change under them.
export function storedAppearance(): AppearanceState {
  const saved = read(APPEARANCE_KEY);
  const choice = APPEARANCE_CHOICES.find((value) => value === saved) ?? "graphite";
  const dark = read(DARK_APPEARANCE_KEY);
  return {
    choice,
    dark: isDarkAppearance(dark) ? dark : isDarkAppearance(choice) ? choice : "graphite",
    saved: true,
  };
}

export function resolveAppearance(
  { choice, dark }: Pick<AppearanceState, "choice" | "dark">,
  lightDevice: boolean,
): Appearance {
  if (choice !== "system") return choice;
  return lightDevice ? "daylight" : dark;
}

function lightDevice(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(LIGHT_DEVICE).matches;
}

// Tints the browser chrome with the void; false while the stylesheet is not in yet.
export function tintChrome(): boolean {
  const tint = getComputedStyle(document.documentElement).getPropertyValue("--color-void").trim();
  if (tint) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", tint);
  return !!tint;
}

export function showAppearance(state: Pick<AppearanceState, "choice" | "dark">): void {
  const shown = resolveAppearance(state, lightDevice());
  document.documentElement.dataset.appearance = shown;
  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute("content", shown === "daylight" ? "light" : "dark");
  tintChrome();
  window.dispatchEvent(new Event(APPEARANCE_EVENT));
}

let state: AppearanceState | undefined;
const listeners = new Set<() => void>();

export function currentAppearance(): AppearanceState {
  state ??= storedAppearance();
  return state;
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(next: AppearanceState): void {
  state = next;
  showAppearance(next);
  for (const listener of listeners) listener();
}

// A dark choice is also what System shows from then on while the device is dark. A browser that
// cannot save keeps the choice for this visit.
export function chooseAppearance(choice: AppearanceChoice): void {
  const dark = isDarkAppearance(choice) ? choice : currentAppearance().dark;
  let saved = true;
  try {
    localStorage.setItem(APPEARANCE_KEY, choice);
    localStorage.setItem(DARK_APPEARANCE_KEY, dark);
  } catch {
    saved = false;
  }
  update({ choice, dark, saved });
}

// Follows the device between light and dark, and a choice made in another tab.
export function followAppearance(): void {
  showAppearance(currentAppearance());
  if (typeof window.matchMedia === "function")
    window
      .matchMedia(LIGHT_DEVICE)
      .addEventListener("change", () => showAppearance(currentAppearance()));
  window.addEventListener("storage", (event) => {
    if (event.key === APPEARANCE_KEY || event.key === DARK_APPEARANCE_KEY || event.key === null)
      update(storedAppearance());
  });
}
