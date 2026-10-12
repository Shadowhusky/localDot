type Listener = (sessionId: string, messageId: string, text: string) => boolean;
const listeners = new Set<Listener>();
export function restoreQueuedDraft(sessionId: string, messageId: string, text: string): boolean {
  for (const listener of listeners) if (listener(sessionId, messageId, text)) return true;
  return false;
}
export function onQueuedDraft(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
