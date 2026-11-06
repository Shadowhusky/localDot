import { useCallback, useEffect, useRef, useState } from "react";

export interface OpenSessionProps {
  // Which task Watch shows is settled. Until then a link can't tell the live task from another.
  known: boolean;
  // The task Watch shows.
  sessionId: string | null;
  // The element id of the decision on show: an approval's or a question's heading.
  decision: string | null;
  // Takes up a task's conversation, as picking it from the list does; false if that can't be done.
  take(sessionId: string): Promise<boolean>;
  select(replayId: string | null): void;
}

// A decision that shows up this soon after the tap is the one it was about.
export const LANDING_MS = 5_000;

// A notification or a toast names a task, and opens it at its decision: the one Watch shows at once,
// any other once its conversation is taken up. Only a task no conversation can take up opens in
// Replay. A link that arrives while the page is still opening waits until it knows which task Watch
// shows.
export function useOpenSession({
  known,
  sessionId,
  decision,
  take,
  select,
}: OpenSessionProps): (sessionId: string | null) => void {
  const [asked, setAsked] = useState<{ id: string } | null>(null);
  const [landed, setLanded] = useState(0);
  const landing = useRef<{ id: string; until: number } | null>(null);
  const latest = useRef({ take, select });
  latest.current = { take, select };

  const open = useCallback((id: string | null) => {
    if (id) setAsked({ id });
  }, []);

  useEffect(() => {
    if (!asked || !known) return;
    setAsked(null);
    const { id } = asked;
    const here = { id, until: Date.now() + LANDING_MS };
    landing.current = here;
    if (id === sessionId) {
      latest.current.select(null);
      setLanded((count) => count + 1);
      return;
    }
    void latest.current.take(id).then((taken) => {
      if (taken || landing.current !== here) return;
      landing.current = null;
      latest.current.select(id);
    });
  }, [asked, known, sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each landing looks for the decision again
  useEffect(() => {
    const target = landing.current;
    if (!decision || target?.id !== sessionId || Date.now() > target.until) return;
    const frame = requestAnimationFrame(() => {
      const heading = document.getElementById(decision);
      if (!heading) return;
      landing.current = null;
      heading.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [decision, sessionId, landed]);

  return open;
}
