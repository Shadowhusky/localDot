import { useEffect, useState } from "react";
import { announce, withdraw } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { Presence } from "../ui/Presence.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import type { StageSwitch } from "./stage-switch.ts";

const SLOW_TITLE = "This conversation's screen is taking longer than usual";
const SLOW_DETAIL = "Its picture hasn't come through yet.";

// Over the stage while a conversation just taken up brings its screen: a likeness of a screen under
// the conversation's name, which gives way to the picture once it is in. A screen that never comes
// is said to be late, with the computer as it is a press away.
export function SwitchCover({
  state,
  onShowComputer,
}: {
  state: StageSwitch | null;
  onShowComputer(): void;
}) {
  const up = state?.phase === "covering" || state?.phase === "slow";
  // While it leaves it keeps what it last said.
  const [held, setHeld] = useState(state);
  if (up && held !== state) setHeld(state);
  const shown = up ? state : held;
  const slow = shown?.phase === "slow";
  const spoken = up && slow;
  useEffect(() => {
    if (!spoken) return;
    announce("stage-switch", `${SLOW_TITLE}. ${SLOW_DETAIL}`);
    return () => withdraw("stage-switch");
  }, [spoken]);
  return (
    <Presence show={up}>
      <div className="switch-cover">
        {slow ? (
          <div className="stage-away-card switch-cover-card">
            <div className="stage-away-text">
              <p className="stage-away-title">{SLOW_TITLE}</p>
              <p className="stage-away-detail">{SLOW_DETAIL}</p>
            </div>
            <Button size="sm" onClick={onShowComputer}>
              Show the computer
            </Button>
          </div>
        ) : (
          <div className="switch-cover-screen" aria-hidden="true">
            <Skeleton loading shape="block" className="switch-cover-window" />
            {shown?.title && <p className="switch-cover-title">{shown.title}</p>}
          </div>
        )}
      </div>
    </Presence>
  );
}
