import type { PremiumSpeed } from "@localdot/protocol";
import { clsx } from "clsx";
import { Icon } from "./Icon.tsx";

// A speed above Standard: one filled bolt for Fast, two for Ultrafast. Its words are the caller's,
// in the name of whatever it marks.
export function SpeedMark({ speed, className }: { speed: PremiumSpeed; className?: string }) {
  return (
    <span className={clsx("ui-speed-mark", className)} data-speed={speed} aria-hidden="true">
      <Icon name="bolt" size={12} />
      {speed === "ultrafast" && <Icon name="bolt" size={12} />}
    </span>
  );
}
