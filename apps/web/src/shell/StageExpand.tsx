import { useEffect, useRef, useState } from "react";
import { IconButton } from "../ui/IconButton.tsx";
import { STILL_MS } from "./focus.ts";

// Keep watching unobstructed. Activity on the picture reveals its control without taking over
// the computer; activity elsewhere in the conversation does not keep it on screen.
export function StageExpand({ phone, onEnter }: { phone: boolean; onEnter(): void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [still, setStill] = useState(false);
  useEffect(() => {
    const picture = ref.current?.closest(".stage");
    if (!picture) return;
    let timer = setTimeout(() => setStill(true), STILL_MS);
    const wake = () => {
      clearTimeout(timer);
      setStill(false);
      timer = setTimeout(() => setStill(true), STILL_MS);
    };
    const events = ["pointerdown", "pointermove", "pointerenter", "focusin"] as const;
    for (const event of events) picture.addEventListener(event, wake, true);
    return () => {
      clearTimeout(timer);
      for (const event of events) picture.removeEventListener(event, wake, true);
    };
  }, []);
  return (
    <span ref={ref} className="stage-expand" data-still={still || undefined}>
      <IconButton
        variant="glass"
        round
        size={phone ? 44 : 32}
        icon="expand"
        label="Full screen"
        kbd={phone ? undefined : ["F"]}
        onClick={onEnter}
      />
    </span>
  );
}
