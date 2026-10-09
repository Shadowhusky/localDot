import { Dot } from "../dot/Dot.tsx";
import { Presence } from "../ui/Presence.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";

// What the stage shows until the daemon has said whether there is a computer: dot waking, and no
// words that could turn out wrong. What comes next fades in as it fades out.
export function BootCurtain({ show, phone }: { show: boolean; phone: boolean }) {
  return (
    <Presence show={show}>
      <div className="boot-curtain" role="status">
        <VisuallyHidden>Starting localDot</VisuallyHidden>
        <Dot size={phone ? 128 : 224} state="waking" />
      </div>
    </Presence>
  );
}
