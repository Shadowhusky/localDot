import { useEffect, useMemo, useRef, useState } from "react";
import { RevealedText } from "../agent/ApprovalValue.tsx";
import { hiddenWarning, revealText } from "../agent/reveal-text.ts";
import { PresenceSlot } from "../dot/PresenceSlot.tsx";
import { Button } from "../ui/Button.tsx";
import { HitButton } from "../ui/HitButton.tsx";
import { useFullLine } from "./FullLine.tsx";
import { LINE_HOLD_MS, LINE_OUT_MS } from "./narration.ts";

export interface LineAction {
  label: string;
  run(trigger: HTMLElement): void;
}

export interface NarratorBandProps {
  line: string;
  speaker: "dot" | "system";
  // Settings → Appearance → Show dot. Without dot beside it, the line names its speaker.
  showDot: boolean;
  // Under dot in place of its line, while the band sits in focus mode's margin: the task's step.
  note?: string;
  // The line is dot's question, right above where the answer goes: nothing in it may hide.
  reveal?: boolean;
  // Not a line about dot's work but one for the user (a question, an approval, a problem, a stop):
  // it comes in at once.
  forUser?: boolean;
  // dot's greeting or tip while nothing goes on: under reduced motion it changes without a fade.
  idle?: boolean;
  // One small step after the line, which goes with it.
  action?: LineAction;
  // Pressing dot opens what changes it.
  dot?: { label: string; open: boolean; onPress(trigger: HTMLButtonElement): void };
  onHover?(over: boolean): void;
}

// The band under the stage (design-v2 §10.17, §11 D): dot docked at the stage's corner and its line
// beside it, two lines at most, crossfading one line to the next.
export function NarratorBand({
  line,
  speaker,
  showDot,
  note,
  reveal = false,
  forUser = false,
  idle = false,
  action,
  dot,
  onHover,
}: NarratorBandProps) {
  const {
    text,
    revealed,
    leaving,
    with: kept,
  } = useLine(line, reveal, reveal || forUser, {
    idle,
    action,
  });
  const warning = useMemo(
    () => (revealed ? hiddenWarning(revealText(text)) : undefined),
    [revealed, text],
  );
  const content = revealed ? <RevealedText text={text} /> : text;
  const whole = useFullLine(text, content);
  const act = text ? kept.action : undefined;
  return (
    <div
      className="narrator"
      data-dot={showDot ? "" : undefined}
      data-empty={!text || undefined}
      onPointerEnter={onHover && (() => onHover(true))}
      onPointerLeave={onHover && (() => onHover(false))}
    >
      {showDot && <PresenceSlot name="dock" className="narrator-dock" />}
      {showDot && dot && (
        <HitButton
          className="narrator-dot"
          label={dot.label}
          expanded={dot.open}
          onClick={dot.onPress}
        />
      )}
      <div
        className="narration"
        data-speaker={speaker}
        data-idle={kept.idle || undefined}
        data-act={act ? "" : undefined}
      >
        <div className="narration-flow">
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
          {act && (
            <span className="narration-act" key={text} data-leaving={leaving || undefined}>
              <Button size="sm" data-inline="" onClick={(event) => act.run(event.currentTarget)}>
                {act.label}
              </Button>
            </span>
          )}
        </div>
        {whole.opener}
      </div>
      {note && <p className="narrator-note num">{note}</p>}
      {whole.full}
    </div>
  );
}

interface Extra {
  idle: boolean;
  action: LineAction | undefined;
}

// The line on show: a new one waits until the last has had its moment, unless it is urgent, fades
// the last out, then in. Whether a line is revealed, and what goes with it, goes with the line.
function useLine(line: string, reveal: boolean, urgent: boolean, extra: Extra) {
  const [text, setText] = useState(line);
  const [revealed, setRevealed] = useState(reveal);
  const [kept, setKept] = useState(extra);
  const [leaving, setLeaving] = useState(false);
  const since = useRef(Date.now());
  const latest = useRef(extra);
  latest.current = extra;
  useEffect(() => {
    if (line === text) {
      setLeaving(false);
      setRevealed(reveal);
      return;
    }
    // Silence has nothing to read, so the first line after it comes in at once.
    const wait = text && !urgent ? Math.max(0, since.current + LINE_HOLD_MS - Date.now()) : 0;
    let swap: ReturnType<typeof setTimeout> | undefined;
    const out = setTimeout(() => {
      setLeaving(true);
      swap = setTimeout(
        () => {
          since.current = Date.now();
          setText(line);
          setRevealed(reveal);
          setKept(latest.current);
          setLeaving(false);
        },
        text ? LINE_OUT_MS : 0,
      );
    }, wait);
    return () => {
      clearTimeout(out);
      clearTimeout(swap);
    };
  }, [line, text, reveal, urgent]);
  return {
    text,
    revealed: revealed || (reveal && line === text),
    leaving,
    with: line === text ? extra : kept,
  };
}
