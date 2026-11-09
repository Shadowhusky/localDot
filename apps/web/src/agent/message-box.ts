// The message box has the keys and nothing in it, so a secret field that comes up can take them: what
// is typed next is meant for that field, and would otherwise be a message.
export function emptyMessageBoxHasKeys(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLTextAreaElement && !active.value && !!active.closest(".composer-card")
  );
}
