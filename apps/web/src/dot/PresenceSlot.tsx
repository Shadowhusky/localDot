import { useCallback } from "react";
import { registerPlace } from "./places.ts";
import type { PresencePlace } from "./presence-rules.ts";

// An empty box that keeps a place for dot; the presence layer puts dot in it.
export function PresenceSlot({ name, className }: { name: PresencePlace; className?: string }) {
  const ref = useCallback(
    (element: HTMLSpanElement | null) => (element ? registerPlace(name, element) : undefined),
    [name],
  );
  return (
    <span
      ref={ref}
      className={className ? `presence-slot ${className}` : "presence-slot"}
      data-place={name}
      aria-hidden="true"
    />
  );
}
