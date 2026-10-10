import { createContext } from "react";

// The end of the thread, where a message waits while it is sent.
export interface OutboxSlot {
  slot: HTMLElement;
  // Brings the end of the thread into view.
  show(): void;
  // While a message there waits on your choice, how to reach it; null once nothing waits.
  needs(reach: (() => void) | null): void;
  // Called just before the composer gives back the lines a sent message took: the room stays
  // under the thread until it grows again, so the message just sent stays where it is.
  keep(): void;
}

export const Outbox = createContext<OutboxSlot | null>(null);
