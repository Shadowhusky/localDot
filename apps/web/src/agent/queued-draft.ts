// Edit on a message that never reached dot asks the composer to take it back into the draft. One
// still queued, dot gives back first: the composer, not the message's row, asks, since the row leaves
// the thread as dot gives it back, often before the reply that carries its words. One Stop left
// unsent comes with its own words.
type Listener = (sessionId: string, messageId: string, unsent?: string) => Promise<boolean> | null;
const listeners = new Set<Listener>();
// Whether the message came back into the draft; null when no composer can take it.
export function editQueued(
  sessionId: string,
  messageId: string,
  unsent?: string,
): Promise<boolean> | null {
  for (const listener of listeners) {
    const taking = listener(sessionId, messageId, unsent);
    if (taking) return taking;
  }
  return null;
}
export function onQueuedEdit(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
