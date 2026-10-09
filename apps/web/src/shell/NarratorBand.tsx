import { useEffect, useMemo, useRef, useState } from "react";
import { RevealedText } from "../agent/ApprovalValue.tsx";
import { hiddenWarning, revealText } from "../agent/reveal-text.ts";
import { PresenceSlot } from "../dot/PresenceSlot.tsx";
import { useFullLine } from "./FullLine.tsx";
import { LINE_HOLD_MS, LINE_OUT_MS } from "./narration.ts";

export interface NarratorBandProps {
  line: string;
  speaker: "dot" | "system";
  // Settings → Appearance → Show dot. Without dot beside it, the line names its speaker.
  showDot: boolean;
  // Under dot in place of its line, while the band sits in focus mode's margin: the task's step.
  note?: string;
  // The line is dot's question, right above where the answer goes: nothing in it may hide.
  reveal?: boolean;
}

// The band under the stage (design-v2 §10.17, §11 D): dot docked at the stage's corner and its line
// beside it, two lines at most, crossfading one line to the next.
export function NarratorBand({ line, speaker, showDot, note, reveal = false }: NarratorBandProps) {
  const { text, revealed, leaving } = useLine(line, reveal);
  const warning = useMemo(
    () => (revealed ? hiddenWarning(revealText(text)) : undefined),
    [revealed, text],
  );
  const content = revealed ? <RevealedText text={text} /> : text;
  const whole = useFullLine(text, content);
  return (
    <div className="narrator" data-dot={showDot ? "" : undefined}>
      {showDot && <PresenceSlot name="dock" className="narrator-dock" />}
      <div className="narration" data-speaker={speaker}>
        <p className="narration-text" aria-live="polite">
          {text && (
            <span
              ref={whole.ref}
              className="narration-line"
              key={text}
              data-leaving={leaving || undefined}
            >
              {speaker === "dot" && (
                <span className={showDot ? "ui-visually-hidden" : "narration-speaker"}>
                  {showDot ? "dot: " : "dot"}
                </span>
              )}
              {content}
            </span>
          )}
          {text && warning && (
            <span className="narration-warning" data-leaving={leaving || undefined}>
              {warning}
            </span>
          )}
        </p>
        {whole.opener}
      </div>
      {note && <p className="narrator-note num">{note}</p>}
      {whole.full}
    </div>
  );
}

// The line on show: a new one waits until the last has had its moment, fades the last out, then in.
// Whether a line is revealed goes with the line.
function useLine(line: string, reveal: boolean) {
  const [text, setText] = useState(line);
  const [revealed, setRevealed] = useState(reveal);
  const [leaving, setLeaving] = useState(false);
  const since = useRef(Date.now());
  useEffect(() => {
    if (line === text) {
      setLeaving(false);
      setRevealed(reveal);
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
          setRevealed(reveal);
          setLeaving(false);
        },
        text ? LINE_OUT_MS : 0,
      );
    }, wait);
    return () => {
      clearTimeout(out);
      clearTimeout(swap);
    };
  }, [line, text, reveal]);
  return { text, revealed: revealed || (reveal && line === text), leaving };
}
