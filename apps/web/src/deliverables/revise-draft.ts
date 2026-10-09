import type { ReviseLink } from "@localdot/protocol";

export interface ReviseDraft {
  readonly link: ReviseLink;
  readonly label: number;
  // An older version is revised in a new linked task even while the task is open.
  readonly newest: boolean;
}
type Listener = (draft: ReviseDraft) => void;
const listeners = new Set<Listener>();

// A file asks the composer to start a revision; the composer owns the text field.
export function requestRevise(draft: ReviseDraft): boolean {
  for (const listener of listeners) listener(draft);
  return listeners.size > 0;
}
export function onReviseRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function revisePrefix(name: string): string {
  return `Revise ${name}: `;
}
// The prefilled text with whatever the user had already typed kept after it.
export function prefill(current: string, name: string): string {
  const prefix = revisePrefix(name);
  if (current.startsWith(prefix)) return current;
  return `${prefix}${current.replace(/^Revise [^:\n]{1,200}: /, "")}`;
}
// The link travels with the message only while the text still names that file.
export function linkFor(text: string, draft: ReviseDraft | null): ReviseLink | undefined {
  return draft && text.startsWith(`Revise ${draft.link.name}`) ? draft.link : undefined;
}
