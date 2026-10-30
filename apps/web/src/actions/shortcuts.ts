// The app's keyboard shortcuts, as the palette's shortcuts page lists them.
export interface Shortcut {
  readonly keys: readonly (readonly string[])[];
  readonly label: string;
}

export const SHORTCUTS: readonly { readonly title: string; readonly rows: readonly Shortcut[] }[] =
  [
    {
      title: "Anywhere",
      rows: [
        { keys: [["Mod", "K"]], label: "Search actions" },
        { keys: [["?"]], label: "Keyboard shortcuts" },
        { keys: [["/"]], label: "Write a message" },
        { keys: [["Mod", "Shift", "."]], label: "Stop the task" },
        { keys: [["Mod", "Shift", "F"], ["F"]], label: "Full screen" },
        { keys: [["Escape"]], label: "Close, or leave full screen" },
      ],
    },
    {
      title: "Message",
      rows: [
        { keys: [["Enter"]], label: "Send" },
        { keys: [["Shift", "Enter"]], label: "New line" },
        { keys: [["Mod", "Enter"]], label: "Send now, while dot works" },
        { keys: [["Alt", "Enter"]], label: "Send after this task" },
        { keys: [["/"]], label: "Commands, at the start of a message" },
        { keys: [["Tab"]], label: "Complete a command" },
      ],
    },
    {
      title: "Replay",
      rows: [
        { keys: [[" "]], label: "Play or pause" },
        { keys: [["K"]], label: "Pause" },
        { keys: [["ArrowLeft"], ["ArrowRight"]], label: "Previous or next step" },
        { keys: [["J"], ["L"]], label: "Back or ahead 10 seconds" },
        { keys: [["["], ["]"]], label: "Slower or faster" },
        { keys: [["B"]], label: "Before and after" },
        { keys: [["I"], ["O"]], label: "Mark the start or end of a clip" },
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
