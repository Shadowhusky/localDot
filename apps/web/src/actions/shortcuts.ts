import { tr } from "../i18n/index.ts";

// The app's keyboard shortcuts, as the palette's shortcuts page lists them.
export interface Shortcut {
  readonly keys: readonly (readonly string[])[];
  readonly label: string;
}

export const SHORTCUTS: readonly { readonly title: string; readonly rows: readonly Shortcut[] }[] =
  [
    {
      title: tr("Anywhere"),
      rows: [
        { keys: [["Mod", "K"]], label: tr("Search actions") },
        { keys: [["?"]], label: tr("Keyboard shortcuts") },
        { keys: [["/"]], label: tr("Write a message") },
        { keys: [["Mod", "Shift", "."]], label: tr("Stop the task") },
        { keys: [["Mod", "Shift", "F"], ["F"]], label: tr("Full screen") },
        { keys: [["Escape"]], label: tr("Close, or leave full screen") },
      ],
    },
    {
      title: tr("Message"),
      rows: [
        { keys: [["Enter"]], label: tr("Send; dot reads it at its next step") },
        { keys: [["Shift", "Enter"]], label: tr("New line") },
        { keys: [["Alt", "Enter"]], label: tr("Send after this task") },
        { keys: [["/"]], label: tr("Commands, at the start of a message") },
        { keys: [["Tab"]], label: tr("Complete a command") },
      ],
    },
    {
      title: tr("Replay"),
      rows: [
        { keys: [[" "]], label: tr("Play or pause") },
        { keys: [["K"]], label: tr("Pause") },
        { keys: [["ArrowLeft"], ["ArrowRight"]], label: tr("Previous or next step") },
        { keys: [["J"], ["L"]], label: tr("Back or ahead 10 seconds") },
        { keys: [["["], ["]"]], label: tr("Slower or faster") },
        { keys: [["B"]], label: tr("Before and after") },
        { keys: [["I"], ["O"]], label: tr("Mark the start or end of a clip") },
      ],
    },
  ];

const editing = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest(
    "input, textarea, select, [contenteditable]:not([contenteditable=false]), .manual-surface",
  );

// Mod+K opens the palette from anywhere but the computer's own keyboard; "?" opens its shortcuts
// outside a field.
export function paletteKey(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "repeat" | "target"
  >,
  apple: boolean,
): "open" | "shortcuts" | null {
  if (event.isComposing || event.repeat || event.altKey) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".manual-surface")) return null;
  if (
    event.key.toLowerCase() === "k" &&
    !event.shiftKey &&
    (apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  )
    return "open";
  if (event.key === "?" && !event.metaKey && !event.ctrlKey && !editing(event.target))
    return "shortcuts";
  return null;
}
