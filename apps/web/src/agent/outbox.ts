import { createContext } from "react";

// The end of the thread, where a message waits while it is sent.
export interface OutboxSlot {
  slot: HTMLElement;
  // Brings the end of the thread into view.
  show(): void;
  // While a message there waits on your choice, how to reach it; null once nothing waits.
  needs(reach: (() => void) | null): void;
}

export const Outbox = createContext<OutboxSlot | null>(null);
