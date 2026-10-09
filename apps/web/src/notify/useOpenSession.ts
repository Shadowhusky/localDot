import { useCallback, useEffect, useRef, useState } from "react";

export interface OpenSessionProps {
  // Which task Watch shows is settled. Until then a link can't tell the live task from another.
  known: boolean;
  // The task Watch shows.
  sessionId: string | null;
  // The element id of the decision on show: an approval's or a question's heading.
  decision: string | null;
  select(replayId: string | null): void;
}

// A decision that shows up this soon after the tap is the one it was about.
export const LANDING_MS = 5_000;

// A notification or a toast names a task: the one Watch shows opens there at its decision, any
// other in Replay. A link that arrives while the page is still opening waits until it knows which
// task Watch shows.
export function useOpenSession({
  known,
  sessionId,
  decision,
  select,
}: OpenSessionProps): (sessionId: string | null) => void {
  const [asked, setAsked] = useState<{ id: string } | null>(null);
  const [landed, setLanded] = useState(0);
  const landing = useRef(0);
  const choose = useRef(select);
  choose.current = select;

  const open = useCallback((id: string | null) => {
    if (id) setAsked({ id });
  }, []);

  useEffect(() => {
    if (!asked || !known) return;
    setAsked(null);
    if (asked.id !== sessionId) {
      landing.current = 0;
      choose.current(asked.id);
      return;
    }
    choose.current(null);
    landing.current = Date.now() + LANDING_MS;
    setLanded((count) => count + 1);
  }, [asked, known, sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each landing looks for the decision again
  useEffect(() => {
    if (!decision || Date.now() > landing.current) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(decision);
      if (!target) return;
      landing.current = 0;
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [decision, landed]);

  return open;
}
