import { type ReactNode, useRef } from "react";

// While hidden, a part of the page keeps what it last showed and sits out the page's renders: React
// passes over an element it has rendered before. Its own state and effects carry on. The first
// render after it hides still goes through, so a sheet closes and a panel takes its hidden look.
export function Held({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  const held = useRef<{ children: ReactNode; hidden: boolean } | null>(null);
  if (!held.current || !hidden || !held.current.hidden) held.current = { children, hidden };
  return held.current.children;
}
