import { useRef } from "react";
import type { AgentTakeover } from "./model.ts";
import type { TaskControls } from "./useTaskControls.ts";

// Input already on its way reaches the computer before dot has it back, unless it takes this long.
const DRAIN_MS = 5000;

// Hand back: what the user sent the computer lands first, then dot has it again. The slot says why
// it can't be pressed, or that it is on its way. While the computer is still confirming the user's
// last input, Hand back stays open: the daemon waits for that confirmation before dot takes over.
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
  const run = async () => {
    if (!takeover || running.current) return;
    running.current = true;
    try {
      await drained(DRAIN_MS);
      await controls.handback(takeover.requestId);
    } finally {
      running.current = false;
    }
  };
  const slot = {
    busy:
      controls.status?.kind === "handback" &&
      (controls.status.phase === "sending" || controls.status.phase === "checking"),
    reason: controls.canHandback ? undefined : "Wait for the computer to be ready",
  };
  return { run, slot };
}
