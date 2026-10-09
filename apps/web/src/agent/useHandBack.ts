import { useRef, useState } from "react";
import type { AgentTakeover } from "./model.ts";
import type { TaskControls } from "./useTaskControls.ts";

// Input already on its way reaches the computer before dot has it back, unless it takes this long.
const DRAIN_MS = 5000;

// Hand back: what the user sent the computer lands first, then dot has it again. The slot says why
// it can't be pressed, or that it is on its way. While the computer is still confirming the user's
// last input, Hand back stays open: the daemon waits for that confirmation before dot takes over.
// Not now hands back the computer dot handed over the same way, and tells dot the user won't do it.
export function useHandBack({
  takeover,
  controls,
  drained,
}: {
  takeover: AgentTakeover | undefined;
  controls: Pick<TaskControls, "handback" | "canHandback" | "status">;
  drained(timeoutMs: number): Promise<boolean>;
}) {
  const running = useRef(false);
  // Which of the two is on its way, so only the one pressed spins.
  const [declining, setDeclining] = useState(false);
  const give = async (declined: boolean) => {
    if (!takeover || running.current) return;
    running.current = true;
    setDeclining(declined);
    try {
      await drained(DRAIN_MS);
      await controls.handback(takeover.requestId, declined ? { declined } : {});
    } finally {
      running.current = false;
    }
  };
  const sending =
    controls.status?.kind === "handback" &&
    (controls.status.phase === "sending" || controls.status.phase === "checking");
  const reason = controls.canHandback ? undefined : "Wait for the computer to be ready";
  return {
    run: () => give(false),
    decline: () => give(true),
    slot: { busy: sending && !declining, reason },
    declineSlot: { busy: sending && declining, reason },
    // Only a hand-off dot made can be declined.
    declinable: !!takeover && takeover.by !== "user",
  };
}
