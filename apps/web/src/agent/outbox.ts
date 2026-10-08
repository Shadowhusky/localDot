import { createContext } from "react";

// The end of the thread, where a message waits while it is sent.
export const Outbox = createContext<HTMLElement | null>(null);
