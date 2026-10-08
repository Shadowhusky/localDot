import { type ReactNode, useEffect, useRef, useState } from "react";
import { afterMotion } from "./finished.ts";

// Keeps what it holds on screen while it leaves: `data-leaving` lets the stylesheet take it out,
// inert, and it unmounts once that motion has ended.
export function Presence({ show, children }: { show: boolean; children: ReactNode }) {
  const [held, setHeld] = useState(show);
  const root = useRef<HTMLDivElement>(null);
  if (show && !held) setHeld(true);
  useEffect(() => {
    if (show || !held) return;
    return afterMotion([root.current], () => setHeld(false));
  }, [show, held]);
  if (!show && !held) return null;
  return (
    <div ref={root} className="ui-presence" data-leaving={show ? undefined : ""} inert={!show}>
      {children}
    </div>
  );
}
