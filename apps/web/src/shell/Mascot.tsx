import { useLayoutEffect, useRef, useState } from "react";
import { Dot } from "../dot/Dot.tsx";
import type { DotState } from "../dot/engine/states.ts";
import { Glyph } from "../dot/Glyph.tsx";

const BADGE = 24;

// dot's mark. In the HUD it is the live badge, whose ball fills the slot while the frame's
// transparent margin (an eighth of its size on each side) overflows it; elsewhere it is the static
// glyph. Until the status model feeds dot directly, the badge follows the shell's own signals: it
// acts under the xenon rim while dot has control and rests while the computer is paused.
export function Mascot() {
  const slot = useRef<HTMLSpanElement>(null);
  const [badge, setBadge] = useState<{ state: DotState; control: boolean } | null>(null);
  useLayoutEffect(() => {
    const hud = slot.current?.closest(".hud");
    if (!hud) return;
    const app = hud.closest(".app");
    const read = () => {
      const control = app?.classList.contains("control") ?? false;
      const state = hud.classList.contains("paused") ? "resting" : control ? "acting" : "idle";
      setBadge((b) => (b?.state === state && b.control === control ? b : { state, control }));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(hud, { attributeFilter: ["class"] });
    if (app) observer.observe(app, { attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={slot} className="mascot">
      {badge ? (
        <Dot
          size={BADGE}
          state={badge.state}
          control={badge.control}
          style={{ margin: -BADGE / 8 }}
        />
      ) : (
        <Glyph />
      )}
    </span>
  );
}
