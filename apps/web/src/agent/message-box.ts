// Just after a key was pressed, the user is typing somewhere: nothing that comes up takes the keys
// from them, or what they type next lands in it.
const TYPING_PAUSE_MS = 3000;
let lastKey = Number.NEGATIVE_INFINITY;
if (typeof document !== "undefined")
  document.addEventListener(
    "keydown",
    () => {
      lastKey = performance.now();
    },
    true,
  );
export const typedLately = () => performance.now() - lastKey < TYPING_PAUSE_MS;

// The message box has the keys and nothing in it, so a secret field that comes up can take them: what
// is typed next is meant for that field, and would otherwise be a message.
export function emptyMessageBoxHasKeys(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLTextAreaElement && !active.value && !!active.closest(".composer-card")
  );
}
