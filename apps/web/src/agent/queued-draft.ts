// Edit on a message that never reached dot asks the composer to take it back into the draft, once
// dot has given back its words: one still queued, from its task; one Stop left unsent, from the
// task's record, which then leaves it out of the thread on every device. The composer, not the
// message's row, asks, since the row leaves the thread as dot gives it back, often before the reply
// that carries its words.
type Listener = (sessionId: string, messageId: string, stopped: boolean) => Promise<boolean> | null;
const listeners = new Set<Listener>();
// Whether the message came back into the draft; null when no composer can take it.
export function editQueued(
  sessionId: string,
  messageId: string,
  stopped = false,
): Promise<boolean> | null {
  for (const listener of listeners) {
    const taking = listener(sessionId, messageId, stopped);
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
