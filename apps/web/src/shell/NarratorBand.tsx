import { useEffect, useRef, useState } from "react";
import { PresenceSlot } from "../dot/PresenceSlot.tsx";

// Each line stays at least this long, so a quick run of steps never flickers.
export const LINE_HOLD_MS = 1000;
const LINE_OUT_MS = 120;

export interface NarratorBandProps {
  line: string;
  speaker: "dot" | "system";
  // Settings → Appearance → Show dot. Without dot beside it, the line names its speaker.
  showDot: boolean;
  // Under dot in place of its line, while the band sits in focus mode's margin: the task's step.
  note?: string;
}

// The band under the stage (design-v2 §10.17, §11 D): dot docked at the stage's corner and its line
// beside it, two lines at most, crossfading one line to the next.
export function NarratorBand({ line, speaker, showDot, note }: NarratorBandProps) {
  const { text, leaving } = useLine(line);
  return (
    <div className="narrator" data-dot={showDot ? "" : undefined}>
      {showDot && <PresenceSlot name="dock" className="narrator-dock" />}
      <p className="narration" data-speaker={speaker} aria-live="polite">
        {text && (
          <span className="narration-line" key={text} data-leaving={leaving || undefined}>
            {speaker === "dot" && (
              <span className={showDot ? "ui-visually-hidden" : "narration-speaker"}>
                {showDot ? "dot: " : "dot"}
              </span>
            )}
            {text}
          </span>
        )}
      </p>
      {note && <p className="narrator-note num">{note}</p>}
    </div>
  );
}

// The line on show: a new one waits until the last has had its moment, fades the last out, then in.
function useLine(line: string) {
  const [text, setText] = useState(line);
  const [leaving, setLeaving] = useState(false);
  const since = useRef(Date.now());
  useEffect(() => {
    if (line === text) {
      setLeaving(false);
      return;
    }
    const wait = Math.max(0, since.current + LINE_HOLD_MS - Date.now());
    let swap: ReturnType<typeof setTimeout> | undefined;
    const out = setTimeout(() => {
      setLeaving(true);
      swap = setTimeout(
        () => {
          since.current = Date.now();
          setText(line);
          setLeaving(false);
        },
        text ? LINE_OUT_MS : 0,
      );
    }, wait);
    return () => {
      clearTimeout(out);
      clearTimeout(swap);
    };
  }, [line, text]);
  return { text, leaving };
}
